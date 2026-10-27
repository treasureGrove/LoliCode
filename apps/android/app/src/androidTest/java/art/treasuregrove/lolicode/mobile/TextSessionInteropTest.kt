package art.treasuregrove.lolicode.mobile

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in, owned synthetic fixture only. Actual RemoteClient/WSS/AES; native failure is a controlled adapter. */
@RunWith(AndroidJUnit4::class)
class TextSessionInteropTest {
    @Test fun existingDesktopSessionsLongHistoryAndUpdatesSurviveReconnect() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("textSessionInterop") == "1")
        val file = File(instrumentation.targetContext.filesDir, "companion-text-fixture.json")
        check(file.isFile && file.length() in 1..16_384) { "owned text fixture unavailable" }
        val fixture = try { wireJson.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject }
        finally { check(file.delete()) { "owned fixture credential cleanup failed" } }
        val pairing = Pairing.parse(fixture.getValue("pairing").toString(), enrollment = false)
        val computer = PairedComputer(pairing, fixture.string("phoneDeviceId"), approved = true,
            accountId = fixture.string("accountId"), desktopDeviceId = fixture.string("desktopDeviceId"), desktopFingerprint = fixture.string("desktopFingerprint"))
        val sessionId = fixture.string("expectedExistingSessionId")
        val longMessageId = fixture.string("expectedLongMessageId")
        val expectedHash = fixture.string("expectedLongTextSha256")
        val updateText = fixture.string("expectedUpdateText")
        check(validSessionId(sessionId) && longMessageId.isNotBlank() && expectedHash.matches(Regex("[0-9a-f]{64}")) && updateText.isNotBlank()) { "owned text fixture metadata invalid" }
        var bodyBytes = 0
        fun count(snapshot: SessionSnapshot) { bodyBytes += snapshot.messages.sumOf { it.body.toByteArray(Charsets.UTF_8).size }; check(bodyBytes <= 128 * 1024) { "synthetic body budget exhausted" } }
        val epochs = mutableListOf<String>()
        var pages = 0
        var firstMessageId = ""
        var originalTotal = 0
        var nativeFailures = 0
        Harness(computer, fixture.string("deviceToken")).use { h ->
            epochs.add(h.connect())
            check(h.request("status").jsonObject.boolean("quietMode")) { "fixture quiet mode not verified" }
            val initialValue = h.request("sessions.list", buildJsonObject { put("offset", 0); put("limit", 3) })
            val first = SessionDirectory.parse(initialValue)
            check(first.revision != null && first.directoryRevision != null) { "directory revisions unavailable" }
            val rows = first.sessions.toMutableList()
            pages++
            var directory = first
            while (directory.nextOffset != null && pages < 8) {
                directory = SessionDirectory.parse(h.request("sessions.list", buildJsonObject { put("offset", directory.nextOffset); put("limit", 3) }))
                check(directory.directoryRevision == first.directoryRevision) { "synthetic directory unexpectedly changed" }
                rows.addAll(directory.sessions); pages++
            }
            check(pages > 1 && directory.nextOffset == null && rows.map { it.id }.distinct().size == rows.size) { "directory pages incomplete" }
            check(rows.any { it.id == sessionId }) { "existing desktop session missing from directory" }
            val directoryAck = h.request("sessions.list", buildJsonObject { put("offset", 0); put("limit", 3); put("knownRevision", first.revision) })
            check(applyDirectoryResponse(directoryAck, first, first.revision) === first) { "directory acknowledgement lost baseline" }
            var deniedBeforeAttach = false
            try { h.request("session.get", buildJsonObject { put("sessionId", sessionId) }) }
            catch (_: IOException) { deniedBeforeAttach = true }
            check(deniedBeforeAttach) { "directory listing unexpectedly granted session content access" }
            check(Session.parse(h.request("session.attach", buildJsonObject { put("sessionId", sessionId) }).jsonObject).id == sessionId) { "attached session identity changed" }
            var current = SessionSnapshot.parse(h.request("session.get", buildJsonObject { put("sessionId", sessionId); put("limit", 6) }).jsonObject)
            check(current.session.id == sessionId && current.historyTotal >= 14 && current.historyRevision != null) { "desktop history unavailable" }
            count(current)
            val same = h.request("session.get", buildJsonObject { put("sessionId", sessionId); put("limit", 6); put("knownRevision", current.revision) }).jsonObject
            check(applySnapshotResponse(same, current, current.revision) === current) { "snapshot acknowledgement lost baseline" }
            while (current.nextHistoryOffset != null) {
                val offset = current.nextHistoryOffset!!
                val older = SessionSnapshot.parse(h.request("session.get", buildJsonObject { put("sessionId", sessionId); put("offset", offset); put("limit", 6) }).jsonObject)
                count(older); current = mergeOlderSnapshot(current, older, offset)
            }
            check(current.messages.size == current.historyTotal) { "history pages incomplete" }
            firstMessageId = current.messages.first().id; originalTotal = current.historyTotal
            var long = current.messages.firstOrNull { it.id == longMessageId } ?: error("long fixture message missing")
            check(long.textTruncated && long.textTotal > 1024) { "long message must expose truncation" }
            var offset = 0
            var chunks = 0
            do {
                val page = MessageTextPage.parse(h.request("message.get", buildJsonObject { put("sessionId", sessionId); put("messageId", longMessageId); put("offset", offset); put("limit", 2000) }).jsonObject)
                bodyBytes += page.text.toByteArray(Charsets.UTF_8).size
                check(bodyBytes <= 128 * 1024 && ++chunks <= 64) { "synthetic body budget exhausted" }
                long = applyMessagePage(sessionId, long, page, offset)
                offset = long.loadedBytes
            } while (long.textTruncated)
            check(chunks > 1 && sha256(long.body) == expectedHash) { "complete long text hash mismatch" }
            h.request("message.send", buildJsonObject { put("sessionId", sessionId); put("text", "LOLICODE_TEXT_PROBE_UPDATE_V1") })
            var changed: SessionSnapshot? = null
            repeat(4) {
                if (changed == null) {
                    kotlinx.coroutines.delay(3000)
                    val snapshot = SessionSnapshot.parse(h.request("session.get", buildJsonObject { put("sessionId", sessionId); put("limit", 6) }).jsonObject)
                    count(snapshot)
                    if (snapshot.messages.any { it.body.contains(updateText) }) changed = snapshot
                }
            }
            check(changed?.session?.id == sessionId && changed!!.historyTotal > originalTotal) { "desktop text update did not synchronize" }
            nativeFailures += h.nativeFailures.get()
        }
        // A new RemoteClient has no mutation queue to replay; attach restores only the explicit selected session.
        Harness(computer, fixture.string("deviceToken")).use { h ->
            epochs.add(h.connect())
            check(epochs[0] != epochs[1]) { "disconnect did not rotate transport epoch" }
            check(Session.parse(h.request("session.attach", buildJsonObject { put("sessionId", sessionId) }).jsonObject).id == sessionId)
            var current = SessionSnapshot.parse(h.request("session.get", buildJsonObject { put("sessionId", sessionId); put("limit", 6) }).jsonObject)
            count(current)
            check(current.messages.any { it.body.contains(updateText) }) { "reconnect lost latest update" }
            while (current.nextHistoryOffset != null) {
                val offset = current.nextHistoryOffset!!
                val older = SessionSnapshot.parse(h.request("session.get", buildJsonObject { put("sessionId", sessionId); put("offset", offset); put("limit", 6) }).jsonObject)
                count(older); current = mergeOlderSnapshot(current, older, offset)
            }
            check(current.historyTotal > originalTotal && current.messages.any { it.id == firstMessageId }) { "reconnect lost existing history" }
            h.request("message.send", buildJsonObject { put("sessionId", sessionId); put("text", "LOLICODE_TEXT_PROBE_COMPLETE_V1") })
            nativeFailures += h.nativeFailures.get()
        }
        instrumentation.sendStatus(0, Bundle().apply {
            putString("textSessionInterop", "RemoteClient/WSS/AES; synthetic-only; directoryPages=$pages; historyMessages=$originalTotal; bodyBytes=$bodyBytes; longTextHashVerified=true; reconnectEpochRotated=true; controlledNativeFailures=$nativeFailures; installedAppAccountUntouched=true")
        })
        Unit
    }

    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private class Harness(computer: PairedComputer, token: String) : AutoCloseable {
        val nativeFailures = AtomicInteger()
        private val events = LinkedBlockingQueue<ConnectionEvent>(128)
        private val remote = RemoteClient(computer, "Owned text fixture", token, DirectPeerFactory { callbacks ->
            nativeFailures.incrementAndGet(); callbacks.failed()
            object : DirectPeer {
                override fun acceptOffer(negotiationId: String, sdp: String) = Unit
                override fun send(frame: String): Boolean = error("controlled native adapter cannot send")
                override fun close() = Unit
            }
        }, onEvent = { events.offer(it) })

        fun connect(): String {
            remote.connect()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
            var epoch: String? = null
            while (System.nanoTime() < deadline) {
                when (val event = events.poll(1, TimeUnit.SECONDS)) {
                    is ConnectionEvent.TransportReady -> { check(event.transport == "text"); epoch = event.epoch }
                    is ConnectionEvent.Plaintext -> if (event.message.string("type") == "pair.approved" && epoch != null) return epoch
                    is ConnectionEvent.Closed -> error("owned text fixture connection closed")
                    else -> Unit
                }
            }
            error("owned text fixture handshake timeout")
        }
        suspend fun request(method: String, params: JsonObject = buildJsonObject {}) = remote.request(method, params)
        override fun close() = remote.close()
    }
}
