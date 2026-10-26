package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal class AccountFixture {
    val value = wireJson.parseToJsonElement(javaClass.getResource("/companion-account-v2-vector.json")!!.readText()).jsonObject
    val desktopKey = value.getValue("desktop").jsonObject
    val phoneKey = value.getValue("phone").jsonObject
    val plaintext = wireJson.parseToJsonElement(value.string("plaintext")).jsonObject
    val pairing = plaintext.getValue("pairing").jsonObject
    val now = pairing.long("expiresAt") - 299_000
    val identity = DeviceIdentity.restore(phoneKey.string("privateKeyPkcs8"), phoneKey.string("publicKey"))
    val desktop = device("desktop", "desktopDeviceId")
    val phone = device("phone", "phoneDeviceId")
    val request = EnrollmentRequest(value.string("requestId"), value.string("accountId"), value.string("challenge"), desktop, phone,
        now - 1_000, pairing.long("expiresAt"), "approved", pairing.string("roomId"), buildJsonObject {
            put("nonce", value.string("nonce")); put("ciphertext", value.string("ciphertext"))
        })
    private fun device(role: String, idKey: String): AccountDevice {
        val key = value.getValue(role).jsonObject
        return AccountDevice(value.string(idKey), "Fixture $role", role, key.string("publicKey"), key.string("fingerprint"), true, now)
    }
    fun requestJson(request: EnrollmentRequest = this.request) = buildJsonObject {
        put("requestId", request.requestId); put("accountId", request.accountId); put("challenge", request.challenge)
        put("desktop", deviceJson(request.desktop)); put("phone", deviceJson(request.phone)); put("createdAt", request.createdAt)
        put("expiresAt", request.expiresAt); put("status", request.status)
        request.roomId?.let { put("roomId", it) }; request.envelope?.let { put("envelope", it) }
    }
    fun deviceJson(device: AccountDevice) = buildJsonObject {
        put("deviceId", device.deviceId); put("deviceName", device.deviceName); put("kind", device.kind)
        put("publicKey", device.publicKey); put("fingerprint", device.fingerprint); put("online", device.online); put("lastSeenAt", device.lastSeenAt)
    }
    fun open(request: EnrollmentRequest = this.request, accountId: String = this.request.accountId,
        phoneId: String = phone.deviceId, expectedDesktop: AccountDevice = desktop, requestId: String = this.request.requestId,
        relay: String = pairing.string("relayUrl"), at: Long = now) =
        openEnrollment(request, accountId, phoneId, identity, expectedDesktop, requestId, relay, at)
    fun envelopeFor(plaintext: JsonObject): JsonObject {
        val key = decodeBase64(value.string("derivedKey")); val nonce = decodeBase64(value.string("nonce"))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(value.string("aad").toByteArray())
        return buildJsonObject { put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(plaintext.toString().toByteArray()))) }
    }
}

class AccountProtocolTest {
    @Test fun decodesTheIndependentNodeCrossLanguageVectorExactly() {
        val fixture = AccountFixture()
        assertEquals(fixture.value.string("transcript"), fixture.request.transcript())
        assertEquals(fixture.value.string("sharedSecret"), encodeBase64(fixture.identity.sharedSecret(fixture.desktop.publicKey)))
        val key = hkdfSha256(fixture.identity.sharedSecret(fixture.desktop.publicKey), decodeBase64(fixture.request.challenge), fixture.request.transcript().toByteArray())
        assertEquals(fixture.value.string("derivedKey"), encodeBase64(key))
        val parsed = EnrollmentRequest.parse(fixture.requestJson())
        val computer = fixture.open(parsed)
        assertEquals(fixture.pairing, computer.pairing.toJson())
        assertEquals("7", computer.accountId)
        assertEquals(fixture.desktop.fingerprint, computer.desktopFingerprint)
        assertTrue(computer.approved)
        assertFalse(computer.toString().contains(computer.pairing.phoneToken))
        assertFalse(computer.toString().contains(computer.pairing.key))
    }

    @Test fun rejectsTamperingAndEveryAccountDeviceRequestAndRelayFence() {
        val f = AccountFixture()
        val bytes = decodeBase64(f.value.string("ciphertext")); bytes[0] = (bytes[0].toInt() xor 1).toByte()
        val badEnvelope = JsonObject(f.request.envelope!! + ("ciphertext" to text(encodeBase64(bytes))))
        val attempts = listOf<() -> Unit>(
            { f.open(f.request.copy(envelope = badEnvelope)) },
            { f.open(accountId = "8") }, { f.open(phoneId = f.desktop.deviceId) },
            { f.open(requestId = "00000000-0000-4000-8000-000000000099") },
            { f.open(f.request.copy(challenge = encodeBase64(ByteArray(32)))) },
            { f.open(expectedDesktop = f.desktop.copy(publicKey = f.phone.publicKey, fingerprint = f.phone.fingerprint)) },
            { f.open(f.request.copy(status = "pending")) }, { f.open(at = f.request.expiresAt) },
            { f.open(relay = "wss://attacker.invalid/companion/ws") },
            { f.open(relay = "wss://lolicode.com/wrong-path") },
            { f.open(f.request.copy(roomId = "a".repeat(32))) },
        )
        attempts.forEach { assertThrows(IllegalArgumentException::class.java) { it() } }
    }

    @Test fun authenticatedButMisboundPlaintextIsStillRejectedBeforePersistence() {
        val f = AccountFixture()
        listOf("accountId", "requestId", "desktopDeviceId", "phoneDeviceId", "desktopKeyFingerprint", "phoneKeyFingerprint").forEach { field ->
            val wrong = JsonObject(f.plaintext + (field to text("other-identity")))
            assertThrows(IllegalArgumentException::class.java) { f.open(f.request.copy(envelope = f.envelopeFor(wrong))) }
        }
        val wrongPairing = JsonObject(f.pairing + ("relayUrl" to text("wss://lolicode.com/companion/ws?token=forbidden")))
        val wrong = JsonObject(f.plaintext + ("pairing" to wrongPairing))
        assertThrows(IllegalArgumentException::class.java) { f.open(f.request.copy(envelope = f.envelopeFor(wrong))) }
    }

    @Test fun publicDirectoryCannotReplaceOrMislabelADeviceKey() {
        val f = AccountFixture()
        assertThrows(IllegalArgumentException::class.java) { AccountDevice.parse(JsonObject(f.deviceJson(f.desktop) + ("fingerprint" to text("0".repeat(64))))) }
        assertThrows(IllegalArgumentException::class.java) { EnrollmentRequest.parse(f.requestJson(f.request.copy(desktop = f.phone))) }
        assertThrows(IllegalArgumentException::class.java) { EnrollmentRequest.parse(f.requestJson(f.request.copy(expiresAt = f.now + 1_000_000))) }
    }
}
