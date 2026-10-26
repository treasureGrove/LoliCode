package art.treasuregrove.lolicode.mobile.protocol

import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Per-account device identity. PKCS8 is stored only inside the Keystore-sealed vault. */
class DeviceIdentity private constructor(private val privateKey: PrivateKey, val publicKey: PublicKey) {
    val publicKeySpki: String get() = encodeBase64(publicKey.encoded)
    val fingerprint: String get() = sha256Hex(publicKey.encoded)
    fun privatePkcs8(): String = encodeBase64(privateKey.encoded)
    fun sharedSecret(peerSpki: String): ByteArray {
        val peer = parsePublic(peerSpki)
        return KeyAgreement.getInstance("ECDH").run { init(privateKey); doPhase(peer, true); generateSecret() }
    }
    override fun toString() = "DeviceIdentity(fingerprint=$fingerprint, private=[redacted])"
    companion object {
        private fun curve(): ECParameterSpec = AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1")); getParameterSpec(ECParameterSpec::class.java)
        }
        fun generate(): DeviceIdentity {
            val pair = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
            return DeviceIdentity(pair.private, pair.public)
        }
        fun restore(pkcs8: String, spki: String): DeviceIdentity {
            val privateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(canonicalBytes(pkcs8, 40, 512)))
            val publicKey = parsePublic(spki)
            // Prove the saved public/private halves agree; do not silently rotate
            // a corrupt key, which would inherit a previous device's approval.
            val probe = generate()
            val left = KeyAgreement.getInstance("ECDH").run { init(privateKey); doPhase(probe.publicKey, true); generateSecret() }
            val right = probe.sharedSecret(spki)
            require(MessageDigest.isEqual(left, right)) { "设备身份密钥损坏，请退出后重新注册设备" }
            return DeviceIdentity(privateKey, publicKey)
        }
        fun parsePublic(spki: String): ECPublicKey {
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(canonicalBytes(spki, 80, 256))) as? ECPublicKey ?: error("设备公钥格式无效")
            val expected = curve()
            require(key.params.curve == expected.curve && key.params.generator == expected.generator && key.params.order == expected.order && key.params.cofactor == expected.cofactor) { "设备公钥必须为 P-256" }
            require(encodeBase64(key.encoded) == spki) { "设备公钥编码无效" }
            return key
        }
    }
}

fun canonicalBytes(value: String, min: Int, max: Int): ByteArray {
    require(value.length <= (max * 4 + 2) / 3) { "加密字段超过大小限制" }
    val bytes = decodeBase64(value)
    require(bytes.size in min..max && encodeBase64(bytes) == value) { "加密字段编码无效" }
    return bytes
}
fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
internal fun hkdfSha256(secret: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
    val extracted = mac.doFinal(secret)
    return try {
        mac.init(SecretKeySpec(extracted, "HmacSHA256")); mac.update(info); mac.update(1.toByte()); mac.doFinal()
    } finally { extracted.fill(0) }
}
