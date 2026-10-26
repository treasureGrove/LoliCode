package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.protocol.*
import java.util.UUID
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Pure JVM fixtures. SDP contains no actual device addresses or credentials. */
class DirectSignalTest {
    private val now = 1_800_000_000_000L
    private val key = ByteArray(32) { it.toByte() }
    private val pairing = Pairing("wss://example.invalid/companion/ws", "1".repeat(32), "2".repeat(64), encodeBase64(key), "Fixture", now + 300_000)
    private val negotiation = "00112233-4455-4677-8899-aabbccddeeff"

    @Test fun exchangesOnlyTheExpectedEncryptedOfferAndAnswerRoles() {
        val phone = DirectSignalCipher(pairing, "phone") { now }
        val desktop = DirectSignalCipher(pairing, "desktop") { now }
        val offer = message("direct.offer")
        val offerFrame = forwarded(desktop.seal(offer), "desktop")
        assertEquals(offer, phone.open(offerFrame))
        assertFalse(offerFrame.toString().contains("fingerprint"))
        assertFalse(offerFrame.toString().contains(negotiation))
        val answer = message("direct.answer")
        assertEquals(answer, desktop.open(forwarded(phone.seal(answer), "phone")))
        assertThrows(IllegalArgumentException::class.java) { desktop.seal(answer) }
        assertThrows(IllegalArgumentException::class.java) { phone.seal(offer) }
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "untrusted") }
    }

    @Test fun rejectsMissingSameOrForgedSenderRolesAndMalformedNegotiationIds() {
        val raw = DirectSignalCipher(pairing, "desktop") { now }.seal(message("direct.offer"))
        val phone = DirectSignalCipher(pairing, "phone") { now }
        assertThrows(IllegalArgumentException::class.java) { phone.open(wireJson.parseToJsonElement(raw).jsonObject) }
        assertThrows(IllegalArgumentException::class.java) { phone.open(forwarded(raw, "phone")) }
        assertThrows(IllegalArgumentException::class.java) { phone.open(forwarded(raw, "server")) }
        val forged = forwarded(DirectSignalCipher(pairing, "phone") { now }.seal(message("direct.answer")), "desktop")
        assertThrows(IllegalArgumentException::class.java) { phone.open(forged) }
        listOf("foreign-request", negotiation.uppercase(), "1-1-1-1-1").forEach { invalid ->
            val malformed = JsonObject(message("direct.offer") + ("negotiationId" to text(invalid)))
            assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "desktop") { now }.seal(malformed) }
        }
        // Expected negotiation ownership is intentionally checked by RemoteClient,
        // where the active WebSocket negotiation is available, rather than here.
    }

    @Test fun acceptsTheFiveMinuteBoundaryAndRejectsStaleOrFutureSignalsOnReceive() {
        listOf(now - 300_000, now + 300_000).forEach { sentAt ->
            val frame = forwarded(DirectSignalCipher(pairing, "desktop") { sentAt }.seal(message("direct.offer", sentAt)), "desktop")
            assertEquals(sentAt, DirectSignalCipher(pairing, "phone") { now }.open(frame).long("sentAt"))
        }
        listOf(now - 300_001, now + 300_001).forEach { sentAt ->
            val frame = forwarded(DirectSignalCipher(pairing, "desktop") { sentAt }.seal(message("direct.offer", sentAt)), "desktop")
            assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "phone") { now }.open(frame) }
        }
    }

    @Test fun rejectsReplayTamperingWrongRoomAndWrongKeyBeforeAcceptingAControlMessage() {
        val frame = forwarded(DirectSignalCipher(pairing, "desktop") { now }.seal(message("direct.offer")), "desktop")
        val phone = DirectSignalCipher(pairing, "phone") { now }
        phone.open(frame)
        assertThrows(IllegalArgumentException::class.java) { phone.open(frame) }
        val modified = decodeBase64(frame.string("ciphertext")).also { it[0] = (it[0].toInt() xor 1).toByte() }
        val tampered = JsonObject(frame + ("ciphertext" to text(encodeBase64(modified))))
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "phone") { now }.open(tampered) }
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing.copy(roomId = "a".repeat(32)), "phone") { now }.open(frame) }
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing.copy(key = encodeBase64(ByteArray(32))), "phone") { now }.open(frame) }
        val wrongNonce = JsonObject(frame + ("nonce" to text(encodeBase64(ByteArray(11)))))
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "phone") { now }.open(wrongNonce) }
        val oversize = JsonObject(frame + ("ciphertext" to text("A".repeat(DirectSignalCipher.MAX_FRAME))))
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "phone") { now }.open(oversize) }
    }

    @Test fun signalingAndTaskAadCannotAuthenticateEachOthersCiphertexts() {
        val signal = forwarded(DirectSignalCipher(pairing, "desktop") { now }.seal(message("direct.offer")), "desktop")
        val disguisedAsTask = JsonObject(signal + ("type" to text("packet")))
        assertThrows(AEADBadTagException::class.java) { PacketCipher(pairing) { now }.open(disguisedAsTask) }

        // All frame fields, sender role, key, room and plaintext are otherwise
        // valid. Only the dedicated task AAD namespace differs from signaling.
        val id = UUID.randomUUID().toString()
        val nonce = ByteArray(12) { (it + 8).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|desktop|$id".toByteArray())
        val taskCiphertext = cipher.doFinal(message("direct.offer").toString().toByteArray())
        val disguisedAsSignal = buildJsonObject {
            put("type", "signal"); put("v", 1); put("id", id); put("from", "desktop")
            put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(taskCiphertext))
        }
        assertThrows(IllegalArgumentException::class.java) { DirectSignalCipher(pairing, "phone") { now }.open(disguisedAsSignal) }
    }

    @Test fun sdpAllowsAnApplicationDataChannelButRejectsRelayMediaAndMissingAuthentication() {
        validateDirectSdp(validSdp())
        val valid = validSdp()
        val attempts = listOf(
            valid + "\r\na=candidate:2 1 udp 16777215 192.0.2.2 60000 typ relay raddr 0.0.0.0 rport 0\r\n",
            valid + "\r\nA=CANDIDATE:2 1 UDP 16777215 192.0.2.2 60000 TYP RELAY\r\n",
            valid + "\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
            valid + "\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
            valid.lineSequence().filterNot { it.startsWith("a=fingerprint:") }.joinToString("\r\n"),
            valid.replace("a=fingerprint:sha-256", "a=fingerprint:sha-1"),
            valid.replace(fingerprint(), List(31) { "AB" }.joinToString(":")),
            valid.lineSequence().filterNot { it.startsWith("m=application ") }.joinToString("\r\n"),
            valid.replace("UDP/DTLS/SCTP", "UDP/NOT-SCTP"),
            valid.replace("v=0", "v=1"),
            valid + "\u0000",
            valid + "a=x:" + "x".repeat(10 * 1024),
            valid + "a=x\r\n".repeat(513),
        )
        attempts.forEachIndexed { index, sdp ->
            assertThrows("invalid SDP fixture $index", IllegalArgumentException::class.java) { validateDirectSdp(sdp) }
        }
    }

    private fun message(type: String, sentAt: Long = now) = buildJsonObject {
        put("type", type); put("negotiationId", negotiation); put("sdp", validSdp()); put("sentAt", sentAt)
    }
    private fun forwarded(raw: String, sender: String) = JsonObject(wireJson.parseToJsonElement(raw).jsonObject + ("from" to text(sender)))
    private fun fingerprint() = List(32) { "AB" }.joinToString(":")
    private fun validSdp() = listOf(
        "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE data",
        "a=fingerprint:sha-256 ${fingerprint()}", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 0.0.0.0", "a=mid:data", "a=sctp-port:5000",
        "a=candidate:1 1 udp 2130706431 192.0.2.1 50000 typ host",
    ).joinToString("\r\n", postfix = "\r\n")
}
