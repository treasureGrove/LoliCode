package art.treasuregrove.lolicode.mobile.protocol

import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*

fun validateDirectSdp(sdp: String) {
    require(sdp.toByteArray().size in 1..10 * 1024 && '\u0000' !in sdp) { "直连会话说明超过限制" }
    val lines = sdp.lineSequence().map { it.trim() }.toList()
    require(lines.size <= 512 && lines.firstOrNull() == "v=0" &&
        lines.any { it.startsWith("m=application ") && (it.contains("DTLS/SCTP") || it.contains("UDP/DTLS/SCTP")) } &&
        lines.none { it.startsWith("m=audio ", true) || it.startsWith("m=video ", true) } &&
        lines.any { it.matches(Regex("^a=fingerprint:sha-256 ([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$")) } &&
        lines.none { it.startsWith("a=candidate:", true) && Regex("\\btyp\\s+relay\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) }) { "直连会话说明无效或包含不支持的中转" }
}

/** Dedicated signaling AAD prevents control/task packets being interchanged. */
class DirectSignalCipher(private val pairing: Pairing, private val role: String = "phone", private val clock: () -> Long = System::currentTimeMillis) {
    private val seen = LinkedHashSet<String>()
    private val random = SecureRandom()
    init { require(role in listOf("phone", "desktop")) }
    fun seal(message: JsonObject): String {
        validate(message, role)
        val plaintext = message.toString().toByteArray()
        val id = UUID.randomUUID().toString(); val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(role, id))
        val frame = buildJsonObject {
            put("type", "signal"); put("v", 1); put("id", id); put("nonce", encodeBase64(nonce))
            put("ciphertext", encodeBase64(cipher.doFinal(plaintext)))
        }.toString()
        require(frame.toByteArray().size <= MAX_FRAME) { "直连信令超过大小限制" }
        return frame
    }
    @Synchronized fun open(frame: JsonObject): JsonObject {
        require(frame.toString().toByteArray().size <= MAX_FRAME && frame.string("type") == "signal" && frame.long("v") == 1L) { "无效的直连信令" }
        val peer = if (role == "phone") "desktop" else "phone"
        val id = frame.string("id")
        require(frame.string("from") == peer && runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false) && id !in seen) { "直连信令来源或序号无效" }
        val nonce = canonicalBytes(frame.string("nonce"), 12, 12)
        val encrypted = canonicalBytes(frame.string("ciphertext"), 16, 12 * 1024)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(peer, id))
        val message = try { wireJson.parseToJsonElement(cipher.doFinal(encrypted).toString(Charsets.UTF_8)) as? JsonObject ?: error("invalid") }
            catch (_: Exception) { throw IllegalArgumentException("直连信令未通过验证") }
        validate(message, peer)
        seen.add(id); if (seen.size > 4096) seen.remove(seen.first())
        return message
    }
    private fun validate(message: JsonObject, sender: String) {
        require(message.keys == setOf("type", "negotiationId", "sdp", "sentAt")) { "直连信令字段无效" }
        require(message.string("type") == if (sender == "desktop") "direct.offer" else "direct.answer") { "直连信令类型无效" }
        val id = message.string("negotiationId")
        require(runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)) { "直连协商标识无效" }
        val sentAt = message.long("sentAt"); val now = clock()
        require(sentAt >= now - 300_000 && sentAt <= now + 300_000) { "直连信令已过期" }
        validateDirectSdp(message.string("sdp"))
    }
    private fun aad(sender: String, id: String) = "lolicode-companion-signaling/1|${pairing.roomId}|$sender|$id".toByteArray()
    companion object { const val MAX_FRAME = 16 * 1024 }
}
