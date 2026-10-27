package art.treasuregrove.lolicode.mobile.protocol

import java.nio.charset.StandardCharsets.UTF_8
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*

/** Separate transport AAD prevents a task packet or an old epoch being reused as text. */
class TextCipher(
    private val pairing: Pairing, val epoch: String, private val role: String = "phone",
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val seen = linkedMapOf<String, Long>()
    private val random = SecureRandom()
    init { require(validEpoch(epoch)); require(role == "phone" || role == "desktop") }

    fun seal(message: JsonObject): String {
        validateTextFrame(message)
        val bytes = message.toString().toByteArray(UTF_8)
        require(bytes.size <= MAX_PLAINTEXT) { "受限文本消息过大，请缩短输入或使用直连" }
        val id = UUID.randomUUID().toString()
        val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(role, id))
        return buildJsonObject {
            put("type", "text"); put("v", 1); put("id", id); put("epoch", epoch)
            put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(bytes)))
        }.toString().also { require(it.toByteArray(UTF_8).size <= MAX_FRAME) }
    }

    @Synchronized fun open(packet: JsonObject): JsonObject {
        require(packet.toString().toByteArray(UTF_8).size <= MAX_FRAME)
        require(packet.keys == setOf("type", "v", "id", "epoch", "nonce", "ciphertext", "from"))
        require(listOf("type", "id", "epoch", "nonce", "ciphertext", "from").all { (packet[it] as? JsonPrimitive)?.isString == true })
        val sender = if (role == "phone") "desktop" else "phone"
        require(packet.string("type") == "text" && packet["v"] == JsonPrimitive(1) && packet.string("epoch") == epoch)
        require(packet.string("from") == sender)
        val id = packet.string("id")
        require(UUID.fromString(id).toString() == id)
        val now = clock()
        seen.entries.removeAll { now >= it.value && now - it.value > 300_000 }
        require(id !in seen && seen.size < 4096) { "文本消息重复或超过接收窗口" }
        val nonce = decodeBase64(packet.string("nonce"))
        val encrypted = decodeBase64(packet.string("ciphertext"))
        require(encodeBase64(nonce) == packet.string("nonce") && encodeBase64(encrypted) == packet.string("ciphertext"))
        require(nonce.size == 12 && encrypted.size in 16..MAX_PLAINTEXT + 16)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(sender, id))
        val bytes = cipher.doFinal(encrypted)
        require(bytes.size <= MAX_PLAINTEXT)
        val message = wireJson.parseToJsonElement(String(bytes, UTF_8)).jsonObject
        val sent = message.long("sentAt")
        require((message["sentAt"] as? JsonPrimitive)?.isString == false && sent >= 0)
        require(sent >= now - 300_000 && sent <= now + 300_000) { "文本消息过期，请检查设备时间" }
        validateTextFrame(message)
        seen[id] = now
        return message
    }

    private fun aad(sender: String, id: String) =
        "lolicode-companion-text/1|${pairing.roomId}|$epoch|$sender|$id".toByteArray(UTF_8)

    companion object {
        const val MAX_FRAME = 8192
        const val MAX_PLAINTEXT = 5500
        fun validEpoch(value: String) = value.matches(Regex("^[0-9a-f]{32}$"))
    }
}

private val mediaKeys = setOf("base64", "image", "images", "image_url", "imageurl", "attachment", "attachments", "binary", "blob", "audio", "video")
private val mediaTypes = setOf("image", "image_url", "input_image", "file", "input_file", "audio", "video", "attachment", "binary")

fun validateTextFrame(message: JsonObject) {
    if (message.string("type") in setOf("logical.part", "logical.cancel")) LogicalJson.validateEnvelope(message)
    else validateTextValue(message)
}

fun validateTextValue(value: JsonElement) {
    var nodes = 0
    fun visit(item: JsonElement, depth: Int) {
        require(depth <= 20 && ++nodes <= LogicalJson.MAX_BYTES) { "文本结构过于复杂" }
        when (item) {
            is JsonObject -> item.forEach { (key, child) ->
                require(key.lowercase() !in mediaKeys) { "受限文本模式不传输图片或附件" }
                require(!(key == "type" && child is JsonPrimitive && child.content.lowercase() in mediaTypes)) { "受限文本模式不传输图片或附件" }
                visit(child, depth + 1)
            }
            is JsonArray -> item.forEach { visit(it, depth + 1) }
            is JsonPrimitive -> if (item.isString) require(!item.content.trimStart().startsWith("data:", true)) { "受限文本模式不接受嵌入附件" }
        }
    }
    visit(value, 0)
}

fun validateTextRequest(method: String, params: JsonObject) {
    require(method in setOf("status", "projects.list", "models.list", "sessions.list", "session.create", "session.attach", "session.get", "message.get", "message.send", "run.cancel", "permission.reply", "question.reply")) { "此操作不支持受限文本模式" }
    require(params.toString().toByteArray(UTF_8).size <= LogicalJson.MAX_BYTES) { "受限文本参数过大，请缩短输入或使用直连" }
    validateTextValue(params)
    if (method == "permission.reply") require(params.string("decision") == "reject") { "请直连查看完整操作后批准；文本模式仍可拒绝" }
}
