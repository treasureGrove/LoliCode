package art.treasuregrove.lolicode.mobile.protocol

import art.treasuregrove.lolicode.mobile.data.*
import java.net.URI
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*

fun validDeviceId(value: String) = value.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) && runCatching { UUID.fromString(value) }.isSuccess

data class AccountDevice(val deviceId: String, val deviceName: String, val kind: String,
    val publicKey: String, val fingerprint: String, val online: Boolean, val lastSeenAt: Long) {
    companion object {
        fun parse(value: JsonObject): AccountDevice {
            val id = value.string("deviceId")
            val name = value.string("deviceName")
            val kind = value.string("kind")
            val key = value.string("publicKey")
            val fingerprint = value.string("fingerprint")
            require(validDeviceId(id) && name.isNotBlank() && name.length <= 120 && name.none { it.isISOControl() } && kind in listOf("phone", "desktop")) { "设备资料无效" }
            val parsed = DeviceIdentity.parsePublic(key)
            require(fingerprint == sha256Hex(parsed.encoded)) { "设备公钥指纹不匹配" }
            return AccountDevice(id, name, kind, key, fingerprint, value.boolean("online"), value.long("lastSeenAt"))
        }
    }
}

data class EnrollmentRequest(val requestId: String, val accountId: String, val challenge: String,
    val desktop: AccountDevice, val phone: AccountDevice, val createdAt: Long, val expiresAt: Long,
    val status: String, val roomId: String?, val envelope: JsonObject?) {
    fun transcript(): String = listOf("lolicode-companion-account/2", accountId, requestId, challenge,
        desktop.deviceId, desktop.fingerprint, phone.deviceId, phone.fingerprint).joinToString("\n")
    companion object {
        fun parse(value: JsonObject): EnrollmentRequest {
            val id = value.string("requestId")
            val account = value.string("accountId")
            require(id.matches(Regex("^[A-Za-z0-9_-]{1,128}$")) && validAccountId(account)) { "连接申请资料无效" }
            val challenge = value.string("challenge")
            canonicalBytes(challenge, 32, 32)
            val desktop = AccountDevice.parse(value["desktop"] as? JsonObject ?: error("连接申请电脑资料无效"))
            val phone = AccountDevice.parse(value["phone"] as? JsonObject ?: error("连接申请手机资料无效"))
            val created = value.long("createdAt"); val expires = value.long("expiresAt")
            val status = value.string("status")
            require(desktop.kind == "desktop" && phone.kind == "phone" && desktop.deviceId != phone.deviceId &&
                created > 0 && expires > created && expires - created <= 330_000 && status in listOf("pending", "approved", "rejected")) { "连接申请资料无效" }
            val room = value.string("roomId").ifBlank { null }
            require(room == null || room.matches(Regex("^[a-f0-9]{32}$"))) { "连接申请房间无效" }
            return EnrollmentRequest(id, account, challenge, desktop, phone, created, expires, status, room, value["envelope"] as? JsonObject)
        }
    }
}

/** All identities and the configured transport are checked before a key is persisted. */
fun openEnrollment(request: EnrollmentRequest, accountId: String, phoneId: String, identity: DeviceIdentity,
    expectedDesktop: AccountDevice, expectedRequestId: String, relayUrl: String,
    now: Long = System.currentTimeMillis(), allowLocal: Boolean = false): PairedComputer {
    require(request.requestId == expectedRequestId && request.accountId == accountId && request.status == "approved" &&
        now >= request.createdAt - 30_000 && now < request.expiresAt && request.phone.deviceId == phoneId &&
        request.phone.publicKey == identity.publicKeySpki && request.phone.fingerprint == identity.fingerprint &&
        request.desktop.deviceId == expectedDesktop.deviceId && request.desktop.publicKey == expectedDesktop.publicKey &&
        request.desktop.fingerprint == expectedDesktop.fingerprint) { "连接授权身份或有效期不匹配" }
    val envelope = request.envelope ?: error("连接授权缺少加密凭据")
    val transcript = request.transcript()
    val secret = identity.sharedSecret(expectedDesktop.publicKey)
    val key = try { hkdfSha256(secret, canonicalBytes(request.challenge, 32, 32), transcript.toByteArray()) } finally { secret.fill(0) }
    val plaintext = try {
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, canonicalBytes(envelope.string("nonce"), 12, 12)))
            updateAAD("$transcript\nenrollment".toByteArray())
            doFinal(canonicalBytes(envelope.string("ciphertext"), 17, 16 * 1024))
        }
    } catch (_: Exception) { throw IllegalArgumentException("连接授权未通过加密验证") }
    finally { key.fill(0) }
    try {
        val data = try { wireJson.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject } catch (_: Exception) { error("连接授权内容无效") }
        require(data.long("v") == 2L && data.string("accountId") == accountId && data.string("requestId") == request.requestId &&
            data.string("desktopDeviceId") == expectedDesktop.deviceId && data.string("phoneDeviceId") == phoneId &&
            data.string("desktopKeyFingerprint") == expectedDesktop.fingerprint && data.string("phoneKeyFingerprint") == identity.fingerprint) { "连接授权内容与设备身份不符" }
        val pairing = try { Pairing.parse(data["pairing"].toString(), now, allowLocal) }
            catch (_: Exception) { throw IllegalArgumentException("连接授权配对凭据无效") }
        require(pairing.roomId == request.roomId && sameRelay(pairing.relayUrl, relayUrl)) { "连接授权中转地址或房间不匹配" }
        return PairedComputer(pairing, phoneId, approved = true, accountId = accountId,
            desktopDeviceId = expectedDesktop.deviceId, desktopFingerprint = expectedDesktop.fingerprint)
    } finally { plaintext.fill(0) }
}

private fun sameRelay(actual: String, expected: String): Boolean = runCatching {
    val left = URI(actual); val right = URI(expected)
    left.userInfo == null && left.rawQuery == null && left.rawFragment == null &&
        left.scheme == right.scheme && left.host == right.host && left.port == right.port && left.rawPath == right.rawPath
}.getOrDefault(false)
