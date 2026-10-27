package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TextProtocolTest {
    private val epoch = "e".repeat(32)
    private fun pairing() = Pairing("wss://example.invalid/", "room", "token", encodeBase64(ByteArray(32) { 9 }), "Fixture", 1234)
    private fun forwarded(raw: String, role: String) = JsonObject(wireJson.parseToJsonElement(raw).jsonObject + ("from" to text(role)))
    private fun body(sent: Long = 1234) = buildJsonObject { put("type", "event.ack"); put("eventId", "ack"); put("sentAt", sent) }

    @Test fun fixedNodeAndRustVectorUsesExactTransportEpochAndRoleAad() {
        val vector = buildJsonObject {
            put("type", "text"); put("v", 1); put("epoch", epoch); put("from", "phone")
            put("id", "00000000-0000-4000-8000-000000000001"); put("nonce", "AQEBAQEBAQEBAQEB")
            put("ciphertext", "wlL1HGOC6kozKymoi_uuct-u5ubHpQulgsdA8A77erNQEyR6BKuI7hJ5JcaRi71WokomOgyhIl_16rZ7hPAmQjx4")
        }
        assertEquals(body(), TextCipher(pairing(), epoch, "desktop") { 1234 }.open(vector))
        assertThrows(Exception::class.java) { TextCipher(pairing(), "f".repeat(32), "desktop") { 1234 }.open(vector) }
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch) { 1234 }.open(JsonObject(vector + ("from" to text("desktop")))) }
    }

    @Test fun freshRoundTripRejectsReplayTamperingWrongRoomAndTime() {
        val sender = TextCipher(pairing(), epoch, "desktop") { 1234 }
        val raw = forwarded(sender.seal(body()), "desktop")
        val receiver = TextCipher(pairing(), epoch) { 1234 }
        assertEquals(body(), receiver.open(raw))
        assertThrows(Exception::class.java) { receiver.open(raw) }
        val ciphertext = decodeBase64(raw.string("ciphertext")).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch) { 1234 }.open(JsonObject(raw + ("ciphertext" to text(encodeBase64(ciphertext))))) }
        assertThrows(Exception::class.java) { TextCipher(pairing().copy(roomId = "other"), epoch) { 1234 }.open(raw) }
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch) { 301235 }.open(raw) }
        val next = "f".repeat(32)
        assertEquals(body(), TextCipher(pairing(), next) { 1234 }.open(forwarded(TextCipher(pairing(), next, "desktop").seal(body()), "desktop")))
    }

    @Test fun textPolicyBoundsUtf8AndRejectsMediaRecursivelyAndApprovalAllow() {
        validateTextRequest("message.send", buildJsonObject { put("text", "hello 世界") })
        validateTextRequest("permission.reply", buildJsonObject { put("decision", "reject") })
        assertThrows(Exception::class.java) { validateTextRequest("permission.reply", buildJsonObject { put("decision", "once") }) }
        assertThrows(Exception::class.java) { validateTextRequest("file.read", buildJsonObject {}) }
        validateTextRequest("message.send", buildJsonObject { put("text", "中".repeat(1500)) })
        assertThrows(Exception::class.java) { validateTextRequest("message.send", buildJsonObject { put("text", "a".repeat(LogicalJson.MAX_BYTES)) }) }
        listOf("""{"text":"data:image/png;base64,AAAA"}""", """{"answers":{"x":{"type":"image_url","url":"https://example.invalid/a.png"}}}""", """{"answers":{"x":{"base64":"AAAA"}}}""").forEach { raw ->
            assertThrows(Exception::class.java) { validateTextValue(wireJson.parseToJsonElement(raw)) }
        }
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch).seal(buildJsonObject { put("text", "a".repeat(5500)) }) }
    }

    @Test fun outerEnvelopeAndBase64EncodingMustBeCanonical() {
        val sender = TextCipher(pairing(), epoch, "desktop")
        var raw = forwarded(sender.seal(body()), "desktop")
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch) { 1234 }.open(JsonObject(raw + ("extra" to text("not-authenticated")))) }
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch) { 1234 }.open(JsonObject(raw + ("v" to text("1")))) }
        var padding = ""
        while (raw.string("ciphertext").length % 4 == 0) {
            padding += "x"
            raw = forwarded(sender.seal(buildJsonObject { put("type", "event.ack"); put("eventId", "ack$padding"); put("sentAt", 1234) }), "desktop")
        }
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val canonical = raw.string("ciphertext")
        val altered = canonical.dropLast(1) + alphabet[alphabet.indexOf(canonical.last()) xor 1]
        assertArrayEquals(decodeBase64(canonical), decodeBase64(altered))
        assertThrows(Exception::class.java) { TextCipher(pairing(), epoch) { 1234 }.open(JsonObject(raw + ("ciphertext" to text(altered)))) }
    }
}
