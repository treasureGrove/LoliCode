package art.treasuregrove.lolicode.mobile.protocol

import java.net.URI
import java.nio.charset.StandardCharsets.UTF_8
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*

val wireJson = Json { ignoreUnknownKeys = true }
fun JsonObject.string(name: String): String = (this[name] as? JsonPrimitive)?.contentOrNull.orEmpty()
fun JsonObject.boolean(name: String): Boolean = (this[name] as? JsonPrimitive)?.booleanOrNull ?: false
fun JsonObject.long(name: String): Long = (this[name] as? JsonPrimitive)?.longOrNull
    ?: throw IllegalArgumentException("缺少有效的 $name")
fun JsonObject.array(name: String): JsonArray = this[name] as? JsonArray ?: JsonArray(emptyList())
fun jsonObject(vararg entries: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*entries))
fun text(value: String): JsonPrimitive = JsonPrimitive(value)
fun validSessionId(value: String): Boolean = value.matches(Regex("^[A-Za-z0-9_:-]{1,180}$"))
fun decodeBase64(value: String): ByteArray {
    require(value.matches(Regex("^[A-Za-z0-9_-]+$"))) { "无效的 base64url" }
    return Base64.getUrlDecoder().decode(value)
}
fun encodeBase64(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)

data class Pairing(
    val relayUrl: String,
    val roomId: String,
    val phoneToken: String,
    val key: String,
    val hostName: String,
    val expiresAt: Long,
) {
    fun toJson() = buildJsonObject {
        put("v", 1); put("relayUrl", relayUrl); put("roomId", roomId)
        put("phoneToken", phoneToken); put("key", key); put("hostName", hostName); put("expiresAt", expiresAt)
    }

    companion object {
        fun parse(raw: String, now: Long = System.currentTimeMillis(), allowLocal: Boolean = false, enrollment: Boolean = true): Pairing {
            require(raw.toByteArray(UTF_8).size <= 8_192) { "配对数据过大" }
            val data = wireJson.parseToJsonElement(raw).jsonObject
            require(data.long("v") == 1L) { "不支持此配对协议版本" }
            val uri = URI(data.string("relayUrl"))
            require(uri.scheme == "wss" || (allowLocal && uri.scheme == "ws")) { "连接必须使用 WSS 加密；本地开发需显式启用" }
            require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null && uri.query == null) { "无效的中转地址" }
            val room = data.string("roomId")
            val token = data.string("phoneToken")
            require(room.matches(Regex("^[0-9a-f]{32}$"))) { "无效的配对房间" }
            require(token.matches(Regex("^[0-9a-f]{64}$"))) { "无效的手机凭据" }
            val key = data.string("key")
            require(decodeBase64(key).size == 32) { "无效的加密密钥" }
            val expires = data.long("expiresAt")
            if (enrollment) require(expires > now && expires <= now + 330_000) { "配对码已过期或设备时间不正确，请在电脑重新生成" }
            val name = data.string("hostName")
            require(name.isNotBlank() && name.length <= 120) { "无效的电脑名称" }
            return Pairing(uri.toASCIIString(), room, token, key, name, expires)
        }
    }
}

/** Pure JVM protocol implementation: the relay never receives a plaintext command. */
class PacketCipher(private val pairing: Pairing, private val clock: () -> Long = System::currentTimeMillis) {
    private val random = SecureRandom()
    private val seen = LinkedHashSet<String>()

    fun seal(plaintext: JsonObject): String {
        val bytes = plaintext.toString().toByteArray(UTF_8)
        require(bytes.size <= MAX_PLAINTEXT) { "消息过大（上限 30 KiB），请缩短回答" }
        val id = UUID.randomUUID().toString()
        val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad("phone", id))
        return buildJsonObject {
            put("type", "packet"); put("v", 1); put("id", id)
            put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(bytes)))
        }.toString()
    }

    @Synchronized
    fun open(packet: JsonObject): JsonObject {
        require(packet.toString().toByteArray(UTF_8).size <= MAX_FRAME) { "收到的消息过大" }
        require(packet.string("type") == "packet" && packet.long("v") == 1L) { "无效的数据包" }
        require(packet.string("from") == "desktop") { "拒绝不明来源的数据包" }
        val id = packet.string("id")
        require(UUID.fromString(id).toString() == id) { "无效的数据包 ID" }
        require(id !in seen) { "拒绝重复数据包" }
        val nonce = decodeBase64(packet.string("nonce"))
        val encrypted = decodeBase64(packet.string("ciphertext"))
        require(nonce.size == 12 && encrypted.size in 16..MAX_CIPHERTEXT) { "无效的加密数据长度" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad("desktop", id))
        val plaintext = cipher.doFinal(encrypted)
        require(plaintext.size <= MAX_PLAINTEXT) { "解密后的消息过大" }
        val message = wireJson.parseToJsonElement(String(plaintext, UTF_8)).jsonObject
        val sentAt = message.long("sentAt")
        val now = clock()
        require(sentAt >= now - 300_000 && sentAt <= now + 300_000) { "消息过期，请检查手机和电脑时间" }
        seen.add(id)
        if (seen.size > 4096) seen.remove(seen.first())
        return message
    }

    private fun aad(role: String, id: String) = "lolicode-companion/1|${pairing.roomId}|$role|$id".toByteArray(UTF_8)

    companion object {
        const val MAX_FRAME = 64 * 1024
        const val MAX_CIPHERTEXT = 48 * 1024
        const val MAX_PLAINTEXT = 30 * 1024
        const val MAX_TASK_TEXT = 20 * 1024
    }
}
