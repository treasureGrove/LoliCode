package art.treasuregrove.lolicode.mobile.protocol

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.Deflater
import java.util.zip.Inflater
import kotlinx.serialization.json.*

/** Bounded logical objects above the unchanged small encrypted transport frames. */
object LogicalJson {
    const val MAX_BYTES = 1_048_576
    const val MAX_COMPRESSED = MAX_BYTES + 65_536
    const val SMALL_BYTES = 5000
    const val PART_BYTES = 3000
    const val CODEC = "zlib-parts-v1"
    const val IDLE_MS = 30_000L
    const val HARD_MS = 60 * 60 * 1000L
    private val required = setOf("type", "v", "transferId", "index", "total", "decodedBytes", "compressedBytes", "sha256", "requestId", "codec", "data")
    data class Encoded(val frames: List<JsonObject>, val transferId: String? = null)
    data class Progress(val transferId: String, val requestId: String, val receivedCompressed: Int = 0, val totalCompressed: Int = 0)
    data class Outcome(val message: JsonObject? = null, val progress: Progress? = null, val cancelled: String? = null)
    private data class Header(val transferId: String, val total: Int, val decoded: Int, val compressed: Int, val sha: String, val requestId: String)

    fun encode(message: JsonObject): Encoded {
        require(!message.string("type").startsWith("logical.")) { "逻辑消息不能嵌套" }
        val bytes = message.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BYTES) { "单次逻辑 JSON 超过 1 MiB，请缩短输入" }
        if (bytes.size <= SMALL_BYTES) return Encoded(listOf(message))
        val compressed = ByteArrayOutputStream()
        val compressor = Deflater()
        try {
            compressor.setInput(bytes); compressor.finish()
            val buffer = ByteArray(8192)
            while (!compressor.finished()) {
                val count = compressor.deflate(buffer)
                require(count > 0 && compressed.size() + count <= MAX_COMPRESSED) { "逻辑消息压缩预算超限" }
                compressed.write(buffer, 0, count)
            }
        } finally { compressor.end() }
        val data = compressed.toByteArray()
        val id = UUID.randomUUID().toString()
        val total = (data.size + PART_BYTES - 1) / PART_BYTES
        val digest = sha256(bytes)
        val requestId = message.string("requestId")
        require(requestId.toByteArray(Charsets.UTF_8).size <= 128 && '\u0000' !in requestId)
        return Encoded((0 until total).map { index -> buildJsonObject {
            put("type", "logical.part"); put("v", 1); put("transferId", id); put("index", index); put("total", total)
            put("decodedBytes", bytes.size); put("compressedBytes", data.size); put("sha256", digest)
            put("requestId", requestId); put("codec", "zlib")
            put("data", encodeBase64(data.copyOfRange(index * PART_BYTES, minOf(data.size, (index + 1) * PART_BYTES))))
        } }, id)
    }

    fun cancel(transferId: String) = buildJsonObject { put("type", "logical.cancel"); put("transferId", transferId) }
    fun validateEnvelope(message: JsonObject) {
        if (message.string("type") == "logical.part") header(message)
        else {
            require(message.string("type") == "logical.cancel" && message.keys - "sentAt" == setOf("type", "transferId"))
            uuid(message.string("transferId")); timestamp(message)
        }
    }
    private fun timestamp(message: JsonObject) {
        message["sentAt"]?.let { require(it is JsonPrimitive && !it.isString && it.longOrNull != null && it.longOrNull!! >= 0) }
    }
    private fun uuid(value: String) { require(UUID.fromString(value).toString() == value) { "逻辑传输标识无效" } }
    private fun number(message: JsonObject, name: String): Int {
        val field = message[name] as? JsonPrimitive ?: error("逻辑分片字段无效")
        require(!field.isString && field.intOrNull != null) { "逻辑分片数值无效" }
        return field.int
    }
    private fun header(message: JsonObject): Header {
        require(message.toString().toByteArray(Charsets.UTF_8).size <= TextCipher.MAX_PLAINTEXT)
        require(message.keys - "sentAt" == required && message["type"] == JsonPrimitive("logical.part") && message["v"] == JsonPrimitive(1))
        require(listOf("transferId", "sha256", "requestId", "codec", "data").all { (message[it] as? JsonPrimitive)?.isString == true })
        timestamp(message)
        val id = message.string("transferId"); uuid(id)
        val total = number(message, "total"); val decoded = number(message, "decodedBytes"); val compressed = number(message, "compressedBytes")
        val index = number(message, "index")
        require(decoded in (SMALL_BYTES + 1)..MAX_BYTES && compressed in 1..MAX_COMPRESSED && total == (compressed + PART_BYTES - 1) / PART_BYTES && index in 0 until total)
        require(message.string("sha256").matches(Regex("[0-9a-f]{64}")) && message.string("codec") == "zlib")
        val requestId = message.string("requestId"); require(requestId.toByteArray(Charsets.UTF_8).size <= 128 && '\u0000' !in requestId)
        val encoded = message.string("data"); require(encoded.length <= 4000); val data = decodeBase64(encoded)
        require(encodeBase64(data) == encoded && data.size == minOf(PART_BYTES, compressed - index * PART_BYTES)) { "逻辑分片编码或长度无效" }
        require(message.toString().toByteArray(Charsets.UTF_8).size <= TextCipher.MAX_PLAINTEXT)
        return Header(id, total, decoded, compressed, message.string("sha256"), requestId)
    }

    class Receiver(private val clock: () -> Long = { System.nanoTime() / 1_000_000 }) {
        private data class Active(val header: Header, val bytes: ByteArrayOutputStream, val started: Long, var touched: Long, var index: Int = 0)
        private var active: Active? = null
        @Synchronized fun clear() { active = null }
        @Synchronized fun cancelRequest(requestId: String): String? {
            val value = active?.takeIf { it.header.requestId == requestId } ?: return null
            active = null; return value.header.transferId
        }
        @Synchronized fun expire(): Progress? {
            val value = active ?: return null
            val now = clock()
            if (now < value.touched || now - value.touched >= IDLE_MS || now - value.started >= HARD_MS) {
                active = null; return Progress(value.header.transferId, value.header.requestId, value.bytes.size(), value.header.compressed)
            }
            return null
        }
        @Synchronized fun ingest(message: JsonObject): Outcome {
            val expired = expire()
            if (message.string("type") == "logical.cancel") {
                validateEnvelope(message)
                val id = message.string("transferId")
                val value = active?.takeIf { it.header.transferId == id }
                if (value != null) active = null
                return Outcome(cancelled = id, progress = value?.let { Progress(id, it.header.requestId, it.bytes.size(), it.header.compressed) })
            }
            if (message.string("type") != "logical.part") return Outcome(message = message)
            try {
                val parsed = header(message)
                val index = number(message, "index")
                require(expired == null || (index == 0 && parsed.transferId != expired.transferId)) { "逻辑传输已超时" }
                if (active == null) {
                    require(index == 0) { "逻辑传输必须从首片开始" }
                    active = Active(parsed, ByteArrayOutputStream(minOf(parsed.compressed, 8192)), clock(), clock())
                }
                val value = active!!
                require(value.header == parsed && value.index == index) { "逻辑分片乱序、重复或元数据变化" }
                val part = decodeBase64(message.string("data"))
                require(value.bytes.size() + part.size <= parsed.compressed)
                value.bytes.write(part); value.index++; value.touched = clock()
                val progress = Progress(parsed.transferId, parsed.requestId, value.bytes.size(), parsed.compressed)
                if (value.index < parsed.total) return Outcome(progress = progress)
                active = null
                require(value.bytes.size() == parsed.compressed)
                val inflater = Inflater()
                val output = ByteArrayOutputStream(minOf(parsed.decoded, 8192))
                try {
                    inflater.setInput(value.bytes.toByteArray())
                    val buffer = ByteArray(8192)
                    while (!inflater.finished()) {
                        val count = inflater.inflate(buffer)
                        require(output.size() + count <= parsed.decoded) { "逻辑消息解压超过声明或 1 MiB 上限" }
                        if (count > 0) output.write(buffer, 0, count)
                        else require(inflater.finished()) { "逻辑消息压缩流无效或未完整到达" }
                    }
                    require(inflater.remaining == 0 && output.size() == parsed.decoded) { "逻辑消息压缩流长度无效" }
                } finally { inflater.end() }
                val bytes = output.toByteArray()
                require(sha256(bytes) == parsed.sha) { "逻辑消息校验失败" }
                val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
                validateJsonDepth(text)
                val complete = wireJson.parseToJsonElement(text) as? JsonObject ?: error("逻辑消息必须是 JSON 对象")
                require(!complete.string("type").startsWith("logical.")) { "逻辑消息不能嵌套" }
                require(complete.string("requestId") == parsed.requestId) { "逻辑消息请求标识不匹配" }
                return Outcome(message = complete, progress = progress)
            } catch (failure: Exception) { active = null; throw IllegalArgumentException("逻辑消息未通过完整性或预算校验") }
        }
    }

    private fun validateJsonDepth(text: String) {
        var depth = 0; var quoted = false; var escaped = false
        for (char in text) {
            if (quoted) { if (escaped) escaped = false else if (char == '\\') escaped = true else if (char == '"') quoted = false }
            else when (char) {
                '"' -> quoted = true
                '{', '[' -> { depth++; require(depth <= 20) { "逻辑 JSON 嵌套过深" } }
                '}', ']' -> { depth--; require(depth >= 0) }
            }
        }
        require(!quoted && depth == 0)
    }

    private fun sha256(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
}
