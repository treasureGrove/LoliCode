package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.File
import java.security.MessageDigest
import java.util.Random
import java.util.UUID
import java.util.zip.Deflater
import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LogicalJsonTest {
    private fun body(text: String) = buildJsonObject { put("type", "response"); put("requestId", "10000000-0000-4000-8000-000000000001"); put("result", buildJsonObject { put("text", text) }) }
    private fun randomText(size: Int): String { val random = Random(7); return buildString { repeat(size) { append(if (it % 17 == 0) ' ' else ('a'.code + random.nextInt(26)).toChar()) } } }
    private fun sized(size: Int): JsonObject { val overhead = body("").toString().toByteArray().size; return body("x".repeat(size - overhead)) }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun deflate(bytes: ByteArray): ByteArray {
        val compressor = Deflater(); val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
        try { compressor.setInput(bytes); compressor.finish(); while (!compressor.finished()) { val n = compressor.deflate(buffer); out.write(buffer, 0, n) } }
        finally { compressor.end() }
        return out.toByteArray()
    }
    private fun parts(bytes: ByteArray, decoded: Int, sha: String, requestId: String = ""): List<JsonObject> {
        val total = (bytes.size + 2999) / 3000; val id = UUID.randomUUID().toString()
        return (0 until total).map { index -> buildJsonObject {
            put("type", "logical.part"); put("v", 1); put("transferId", id); put("index", index); put("total", total)
            put("decodedBytes", decoded); put("compressedBytes", bytes.size); put("sha256", sha); put("requestId", requestId); put("codec", "zlib")
            put("data", encodeBase64(bytes.copyOfRange(index * 3000, minOf(bytes.size, (index + 1) * 3000))))
        } }
    }
    private fun rejects(frames: List<JsonObject>) = assertThrows(Exception::class.java) { val receiver = LogicalJson.Receiver(); frames.forEach(receiver::ingest) }

    @Test fun independentPythonZlibVectorIsAcceptedAsOneCompleteObject() {
        val vector = generateSequence(File(System.getProperty("user.dir") ?: error("missing test directory"))) { it.parentFile }
            .map { File(it, "docs/architecture/fixtures/companion-logical-v1-vector.json") }.first { it.isFile }
            .readText().let { wireJson.parseToJsonElement(it).jsonObject }
        val receiver = LogicalJson.Receiver(); val frames = vector.array("parts")
        assertNull(receiver.ingest(frames.first().jsonObject).message)
        assertEquals(vector["payload"], receiver.ingest(frames.last().jsonObject).message)
    }

    @Test fun exactOneMiBIsAtomicAndOneByteAboveIsRejectedBeforeTransfer() {
        val message = sized(LogicalJson.MAX_BYTES)
        val encoded = LogicalJson.encode(message)
        val receiver = LogicalJson.Receiver(); var completed: JsonObject? = null
        encoded.frames.forEachIndexed { index, part ->
            assertTrue(part.toString().toByteArray().size <= 5500)
            val result = receiver.ingest(part)
            if (index < encoded.frames.lastIndex) assertNull(result.message) else completed = result.message
        }
        assertEquals(message, completed)
        assertThrows(Exception::class.java) { LogicalJson.encode(sized(LogicalJson.MAX_BYTES + 1)) }
        assertNull(LogicalJson.encode(sized(5000)).transferId)
        assertNotNull(LogicalJson.encode(sized(5001)).transferId)
    }

    @Test fun partsEnforceCanonicalLengthsOrderMetadataAndBase64() {
        val encoded = LogicalJson.encode(body(randomText(25_000))).frames
        assertTrue(encoded.size > 2)
        rejects(listOf(encoded[1]))
        rejects(listOf(encoded[0], encoded[0]))
        rejects(listOf(encoded[0], JsonObject(encoded[1] + ("sha256" to text("0".repeat(64))))))
        rejects(listOf(JsonObject(encoded[0] + ("index" to text("0")))))
        rejects(listOf(JsonObject(encoded[0] + ("total" to JsonPrimitive(encoded.size + 1)))))
        rejects(listOf(JsonObject(encoded[0] + ("extra" to text("x")))))
        rejects(listOf(JsonObject(encoded[0] + ("data" to text(encoded[0].string("data") + "=")))))
        rejects(listOf(JsonObject(encoded[0] + ("data" to text(encodeBase64(decodeBase64(encoded[0].string("data")).dropLast(1).toByteArray()))))))
    }

    @Test fun smallMessagesCanInterleaveButAnotherLargeTransferCannot() {
        val original = body(randomText(12_000)); val frames = LogicalJson.encode(original).frames
        val receiver = LogicalJson.Receiver(); assertNull(receiver.ingest(frames.first()).message)
        val small = buildJsonObject { put("type", "event.ack"); put("eventId", "small") }
        assertEquals(small, receiver.ingest(small).message)
        var received: JsonObject? = null
        frames.drop(1).forEach { received = receiver.ingest(it).message }
        assertEquals(original, received)
        rejects(listOf(frames.first(), LogicalJson.encode(body(randomText(13_000))).frames.first()))
    }

    @Test fun cancellationEpochResetAndIdleExpiryNeverDeliverPartialBodies() {
        var now = 0L; val receiver = LogicalJson.Receiver { now }
        val frames = LogicalJson.encode(body(randomText(12_000))).frames
        assertNull(receiver.ingest(frames.first()).message)
        receiver.ingest(LogicalJson.cancel(frames.first().string("transferId")))
        assertThrows(Exception::class.java) { receiver.ingest(frames[1]) }
        receiver.ingest(frames.first()); receiver.clear()
        assertThrows(Exception::class.java) { receiver.ingest(frames[1]) }
        receiver.ingest(frames.first()); now = LogicalJson.IDLE_MS
        assertEquals(frames.first().string("requestId"), receiver.expire()!!.requestId)
        assertThrows(Exception::class.java) { receiver.ingest(frames[1]) }
    }

    @Test fun inflaterRejectsBombTrailingDataWrongHashAndNonObject() {
        val bomb = "x".repeat(LogicalJson.MAX_BYTES + 8192).toByteArray()
        rejects(parts(deflate(bomb), LogicalJson.MAX_BYTES, digest(bomb)))
        val raw = body(randomText(8000)).toString().toByteArray()
        rejects(parts(deflate(raw) + byteArrayOf(1, 2, 3), raw.size, digest(raw), body("").string("requestId")))
        rejects(parts(deflate(raw), raw.size, "0".repeat(64), body("").string("requestId")))
        val array = ("[\"" + "x".repeat(6000) + "\"]").toByteArray()
        rejects(parts(deflate(array), array.size, digest(array)))
        val media = buildJsonObject { put("type", "response"); put("result", buildJsonObject { put("image", "x".repeat(6000)) }) }.toString().toByteArray()
        val receiver = LogicalJson.Receiver(); var decoded: JsonObject? = null
        parts(deflate(media), media.size, digest(media)).forEach { decoded = receiver.ingest(it).message }
        assertNotNull(decoded) // Media policy belongs to the text transport, not the generic codec.
        assertThrows(Exception::class.java) { validateTextValue(decoded!!) }
    }

    @Test fun encryptedPartsStayUnderExistingCipherLimitsAndReceiveSemanticValidationOnlyAfterAssembly() {
        val pairing = Pairing("wss://fixture.invalid/", "room", "token", encodeBase64(ByteArray(32) { 9 }), "Fixture", 1234)
        val sender = TextCipher(pairing, "e".repeat(32), "desktop")
        val cipher = TextCipher(pairing, "e".repeat(32))
        val receiver = LogicalJson.Receiver()
        val original = body(randomText(20_000)); var complete: JsonObject? = null
        for (part in LogicalJson.encode(original).frames) {
            val fresh = JsonObject(part + ("sentAt" to JsonPrimitive(System.currentTimeMillis())))
            val raw = wireJson.parseToJsonElement(sender.seal(fresh)).jsonObject
            assertTrue(raw.toString().toByteArray().size + 17 <= 8192)
            complete = receiver.ingest(cipher.open(JsonObject(raw + ("from" to text("desktop"))))).message
        }
        assertEquals(original, complete)
    }
}
