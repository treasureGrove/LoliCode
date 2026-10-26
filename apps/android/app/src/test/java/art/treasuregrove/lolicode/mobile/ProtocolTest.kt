package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.protocol.*
import java.nio.charset.StandardCharsets.UTF_8
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private val now = 1_792_713_600_000L
    private val pairing = Pairing("wss://relay.example/companion", "0123456789abcdef0123456789abcdef", "ab".repeat(32), encodeBase64(ByteArray(32) { it.toByte() }), "测试电脑", now + 300_000)
    private val id = "67e55044-10b1-426f-9247-bb680e5fe0c8"

    @Test fun enrollmentRequiresWssAndFreshCredentials() {
        assertEquals(pairing, Pairing.parse(pairing.toJson().toString(), now))
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(pairing.copy(relayUrl = "ws://192.168.1.2/companion").toJson().toString(), now) }
        assertEquals("ws://127.0.0.1:8788/companion", Pairing.parse(pairing.copy(relayUrl = "ws://127.0.0.1:8788/companion").toJson().toString(), now, allowLocal = true).relayUrl)
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(pairing.copy(expiresAt = now - 1).toJson().toString(), now) }
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(pairing.copy(key = "YQ").toJson().toString(), now) }
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(pairing.copy(relayUrl = "wss://user:password@relay.example/companion").toJson().toString(), now) }
    }

    @Test fun storedPairingCanReconnectAfterQrExpiration() {
        assertEquals(pairing, Pairing.parse(pairing.toJson().toString(), now + 86_400_000, enrollment = false))
    }

    @Test fun decryptsNodeAesGcmInteropFixture() {
        val fixture = javaClass.getResource("/node-desktop-packet.json")!!.readText()
        val opened = PacketCipher(pairing) { now }.open(wireJson.parseToJsonElement(fixture).jsonObject)
        assertEquals("pair.approved", opened.string("type"))
        assertEquals("测试电脑", opened.string("hostName"))
    }

    @Test fun rejectsReflectedTamperedExpiredAndRepeatedPackets() {
        val message = buildJsonObject { put("type", "event"); put("sentAt", now) }
        val packet = desktopPacket(message)
        val receiver = PacketCipher(pairing) { now }
        assertEquals("event", receiver.open(packet).string("type"))
        assertThrows(IllegalArgumentException::class.java) { receiver.open(packet) }
        assertThrows(IllegalArgumentException::class.java) { PacketCipher(pairing) { now }.open(JsonObject(packet + ("from" to text("phone")))) }
        val tampered = decodeBase64(packet.string("ciphertext")).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { PacketCipher(pairing) { now }.open(JsonObject(packet + ("ciphertext" to text(encodeBase64(tampered))))) }
        assertThrows(IllegalArgumentException::class.java) { PacketCipher(pairing) { now + 300_001 }.open(packet) }
        assertThrows(Exception::class.java) { PacketCipher(pairing.copy(roomId = "f".repeat(32))) { now }.open(packet) }
    }

    @Test fun phonePacketsUseFreshNonceAndBindRoleRoomAndPacketId() {
        val sender = PacketCipher(pairing) { now }
        val message = buildJsonObject { put("type", "request"); put("sentAt", now) }
        val first = wireJson.parseToJsonElement(sender.seal(message)).jsonObject
        val second = wireJson.parseToJsonElement(sender.seal(message)).jsonObject
        assertNotEquals(first.string("id"), second.string("id"))
        assertNotEquals(first.string("nonce"), second.string("nonce"))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, decodeBase64(first.string("nonce"))))
        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|phone|${first.string("id")}".toByteArray(UTF_8))
        assertEquals(message.toString(), String(cipher.doFinal(decodeBase64(first.string("ciphertext"))), UTF_8))
    }

    @Test fun rejectsOversizedPlaintextBeforeSending() {
        assertThrows(IllegalArgumentException::class.java) { PacketCipher(pairing).seal(buildJsonObject { put("text", "a".repeat(40_000)) }) }
    }

    @Test fun nativeSessionIdsAreAcceptedForNotifications() {
        assertTrue(validSessionId("lc:67e55044-10b1-426f-9247-bb680e5fe0c8"))
        assertFalse(validSessionId("lc:bad\nintent"))
        assertFalse(validSessionId("a".repeat(181)))
    }

    private fun desktopPacket(message: JsonObject): JsonObject {
        val nonce = ByteArray(12) { it.toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|desktop|$id".toByteArray(UTF_8))
        return buildJsonObject {
            put("type", "packet"); put("v", 1); put("id", id); put("from", "desktop")
            put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(message.toString().toByteArray(UTF_8))))
        }
    }
}
