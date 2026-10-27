package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.net.InetAddress
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

/** Actual loopback WS/AES exchange; native ICE remains a fake adapter in these cases. */
class TextTransportTest {
    @Test fun failedDirectKeepsSocketAndTextNeedsEpochChallengeAndHostApproval() = Harness().use { h ->
        h.start()
        assertEquals(listOf("text-v1"), h.hello.array("capabilities").map { it.jsonPrimitive.content })
        h.peer.events.failed()
        h.event { it is ConnectionEvent.WaitingForTransport }
        assertEquals(1, h.peer.closed.get())
        assertThrows(IllegalStateException::class.java) { runBlocking { h.client.request("status") } }
        h.textHandshake()
        assertThrows(IllegalStateException::class.java) { runBlocking { h.client.request("status") } }
        h.approve()
        runBlocking {
            val pending = async(Dispatchers.Default) { h.client.request("status") }
            val command = h.readPhone()
            assertEquals("status", command.string("method"))
            h.send(buildJsonObject { put("type", "response"); put("requestId", command.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis()); put("result", buildJsonObject { put("quietMode", true) }) })
            assertTrue(withTimeout(5000) { pending.await() }.jsonObject.boolean("quietMode"))
        }
        h.client.acknowledgeEvent("fixture-event")
        assertEquals("event.ack", h.readPhone().string("type"))
        h.peer.events.opened() // old native callbacks cannot reclaim text transport
        assertThrows(IllegalArgumentException::class.java) { runBlocking { h.client.request("message.send", buildJsonObject { put("text", "data:image/png;base64,AAAA") }) } }
        assertTrue(h.sentTypes.all { it == "hello" || it == "text" })
    }

    @Test fun epochRotationFailsPendingMutationWithoutReplayingIt() = Harness().use { h ->
        h.start(); h.textHandshake(); h.approve()
        runBlocking {
            val pending = async(Dispatchers.Default) { runCatching { h.client.request("message.send", buildJsonObject { put("sessionId", "s1"); put("text", "one synthetic task") }) } }
            assertEquals("message.send", h.readPhone().string("method"))
            h.textHandshake("f".repeat(32))
            assertTrue(withTimeout(5000) { pending.await() }.isFailure)
        }
        h.approve()
        assertNull(h.wire.poll(200, TimeUnit.MILLISECONDS))
    }

    @Test fun directDeadlineWaitsForTextAndQuotaFailureIsNotAuthenticationFailure() = Harness(timeout = 25).use { h ->
        h.start(); h.event { it is ConnectionEvent.WaitingForTransport }
        h.textHandshake(); h.approve()
        h.socket.send("""{"type":"error","code":"monthly_limit"}""")
        val event = h.event { it is ConnectionEvent.Closed } as ConnectionEvent.Closed
        assertFalse(event.authenticationRejected)
        assertFalse(event.retryable)
    }

    @Test fun quotaOnlyCloseDoesNotInvalidateAccountAndPeerOfflineCancelsMutation() {
        Harness().use { h ->
            h.start(); h.textHandshake(); h.approve()
            h.socket.close(1008, "text_slow_peer")
            val closed = h.event { it is ConnectionEvent.Closed } as ConnectionEvent.Closed
            assertFalse(closed.authenticationRejected)
            assertFalse(closed.retryable)
        }
        Harness().use { h ->
            h.start(); h.textHandshake(); h.approve()
            runBlocking {
                val pending = async(Dispatchers.Default) { runCatching { h.client.request("message.send", buildJsonObject { put("sessionId", "s1"); put("text", "one task") }) } }
                assertEquals("message.send", h.readPhone().string("method"))
                h.socket.send("""{"type":"peer","online":false,"textRelay":false}""")
                h.event { it is ConnectionEvent.WaitingForTransport }
                assertTrue(withTimeout(5000) { pending.await() }.isFailure)
            }
            h.textHandshake("d".repeat(32)); h.approve()
            assertNull(h.wire.poll(200, TimeUnit.MILLISECONDS))
        }
    }

    @Test fun cancelBypassesPacedLargeMutationAndPreventsItsLateSend() = Harness().use { h ->
        h.start(); h.textHandshake(); h.approve()
        runBlocking {
            val mutation = async(Dispatchers.Default) { runCatching { h.client.request("message.send", buildJsonObject { put("sessionId", "s1"); put("text", "x".repeat(1400)) }) } }
            delay(100)
            val cancellation = async(Dispatchers.Default) { h.client.request("run.cancel", buildJsonObject { put("sessionId", "s1") }) }
            val command = h.readPhone()
            assertEquals("run.cancel", command.string("method"))
            h.send(buildJsonObject { put("type", "response"); put("requestId", command.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis()); put("result", buildJsonObject {}) })
            withTimeout(3000) { cancellation.await() }
            assertTrue(withTimeout(1000) { mutation.await() }.isFailure)
            assertNull(h.wire.poll(5, TimeUnit.SECONDS))
        }
    }

    @Test fun rejectingARealUuidApprovalCanBypassAnOutstandingSnapshotRead() = Harness().use { h ->
        h.start(); h.textHandshake(); h.approve()
        runBlocking {
            val session = "lc:00000000-0000-4000-8000-000000000001"
            val poll = async(Dispatchers.Default) { h.client.request("session.get", buildJsonObject { put("sessionId", session) }) }
            val pollCommand = h.readPhone()
            val reject = async(Dispatchers.Default) { h.client.request("permission.reply", buildJsonObject { put("sessionId", session); put("permissionId", "00000000-0000-4000-8000-000000000002"); put("decision", "reject") }) }
            val command = h.readPhone()
            assertEquals("permission.reply", command.string("method"))
            assertTrue(h.lastWireBytes in 513..1024)
            listOf(command, pollCommand).forEach { request -> h.send(buildJsonObject { put("type", "response"); put("requestId", request.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis()); put("result", buildJsonObject {}) }) }
            withTimeout(3000) { reject.await(); poll.await() }
            Unit
        }
    }

    @Test fun logicalReplyIsAtomicAndTicketRefreshKeepsItsEpochAndPendingAssembly() = Harness().use { h ->
        h.start(); h.textHandshake(); h.approve(logical = true)
        runBlocking {
            val waiting = async(Dispatchers.Default) { h.client.request("session.get", buildJsonObject { put("sessionId", "s1") }) }
            val request = h.readPhone()
            val text = syntheticText(24_000)
            val response = buildJsonObject { put("type", "response"); put("requestId", request.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis()); put("result", buildJsonObject { put("text", text) }) }
            val encoded = LogicalJson.encode(response)
            assertTrue(encoded.frames.size > 2)
            h.sendPart(encoded.frames.first())
            delay(100); assertFalse(waiting.isCompleted)
            val expiry = System.currentTimeMillis() + 900_000
            val refresh = async(Dispatchers.Default) { h.client.requestAuthRefresh("q".repeat(40), expiry) }
            val raw = h.wire.poll(5, TimeUnit.SECONDS) ?: error("missing auth refresh")
            assertEquals("auth.refresh", raw.string("type"))
            h.socket.send(buildJsonObject { put("type", "auth.renewed"); put("v", 1); put("requestId", raw.string("requestId")); put("expiresAt", expiry) }.toString())
            assertEquals(expiry, withTimeout(3000) { refresh.await() })
            assertFalse(waiting.isCompleted)
            encoded.frames.drop(1).forEach(h::sendPart)
            assertEquals(text, withTimeout(5000) { waiting.await() }.jsonObject.string("text"))
        }
    }

    @Test fun stopCancelsAMultiPartUploadWithoutSendingItsRemainderOrReplayingMutation() = Harness().use { h ->
        h.start(); h.textHandshake(); h.approve(logical = true)
        runBlocking {
            val uploading = async(Dispatchers.Default) { runCatching { h.client.request("message.send", buildJsonObject { put("sessionId", "s1"); put("text", syntheticText(60_000)) }) } }
            val first = h.readPhone(); assertEquals("logical.part", first.string("type")); assertTrue(first.long("total") > 2)
            val stopping = async(Dispatchers.Default) { h.client.request("run.cancel", buildJsonObject { put("sessionId", "s1") }) }
            var cancel: JsonObject? = null; var transferCancelled = false
            repeat(2) {
                val next = h.readPhone()
                when (next.string("type")) {
                    "logical.cancel" -> { assertEquals(first.string("transferId"), next.string("transferId")); transferCancelled = true }
                    "request" -> { assertEquals("run.cancel", next.string("method")); cancel = next }
                    else -> fail("an aborted upload must not send another part")
                }
            }
            assertTrue(transferCancelled); assertNotNull(cancel)
            h.send(buildJsonObject { put("type", "response"); put("requestId", cancel!!.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis()); put("result", buildJsonObject {}) })
            withTimeout(3000) { stopping.await() }
            assertTrue(withTimeout(3000) { uploading.await() }.isFailure)
            assertNull(h.wire.poll(5, TimeUnit.SECONDS))
        }
    }

    @Test fun malformedRefreshAckFailsClosedAndOldPeerCannotReceiveLargeLogicalMessages() {
        Harness().use { h ->
            h.start(); h.textHandshake(); h.approve()
            assertThrows(Exception::class.java) { runBlocking { h.client.request("message.send", buildJsonObject { put("sessionId", "s1"); put("text", "x".repeat(6000)) }) } }
            assertNull(h.wire.poll(100, TimeUnit.MILLISECONDS))
        }
        Harness().use { h ->
            h.start(); h.textHandshake(); h.approve(logical = true)
            runBlocking {
                val expiry = System.currentTimeMillis() + 900_000
                val refresh = async(Dispatchers.Default) { runCatching { h.client.requestAuthRefresh("q".repeat(40), expiry) } }
                val raw = h.wire.poll(5, TimeUnit.SECONDS) ?: error("missing auth refresh")
                h.socket.send(buildJsonObject { put("type", "auth.renewed"); put("v", 1); put("requestId", raw.string("requestId")); put("expiresAt", expiry + 1) }.toString())
                assertTrue(withTimeout(3000) { refresh.await() }.isFailure)
                assertFalse((h.event { it is ConnectionEvent.Closed } as ConnectionEvent.Closed).authenticationRejected)
            }
        }
    }

    private fun syntheticText(size: Int): String { val random = java.util.Random(7); return buildString { repeat(size) { append(if (it % 17 == 0) ' ' else ('a'.code + random.nextInt(26)).toChar()) } } }

    @Test fun textLogicalReplyStillRejectsEmbeddedMediaAfterCompleteAssembly() = Harness().use { h ->
        h.start(); h.textHandshake(); h.approve(logical = true)
        runBlocking {
            val waiting = async(Dispatchers.Default) { runCatching { h.client.request("session.get", buildJsonObject { put("sessionId", "s1") }) } }
            val command = h.readPhone()
            val response = buildJsonObject { put("type", "response"); put("requestId", command.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis())
                put("result", buildJsonObject { put("toolInput", buildJsonObject { put("data", "data:text/plain;base64,AAAA") }); put("padding", "x".repeat(6000)) }) }
            LogicalJson.encode(response).frames.forEach(h::sendPart)
            assertTrue(withTimeout(3000) { waiting.await() }.isFailure)
            assertFalse((h.event { it is ConnectionEvent.Closed } as ConnectionEvent.Closed).authenticationRejected)
        }
    }

    private class Peer(val events: DirectPeerEvents) : DirectPeer {
        val closed = AtomicInteger()
        override fun acceptOffer(negotiationId: String, sdp: String) = Unit
        override fun send(frame: String): Boolean = error("text test must never send a native payload")
        override fun close() { closed.incrementAndGet() }
    }
    private class Harness(timeout: Long = 40_000) : AutoCloseable {
        val server = MockWebServer()
        val wire = LinkedBlockingQueue<JsonObject>()
        val events = LinkedBlockingQueue<ConnectionEvent>()
        val sockets = LinkedBlockingQueue<WebSocket>()
        val peers = LinkedBlockingQueue<Peer>()
        val sentTypes = mutableListOf<String>()
        val pairing: Pairing
        val client: RemoteClient
        lateinit var socket: WebSocket
        lateinit var peer: Peer
        lateinit var hello: JsonObject
        lateinit var cipher: TextCipher
        var lastWireBytes = 0
        init {
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { sockets.put(webSocket) }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = wireJson.parseToJsonElement(text).jsonObject
                    synchronized(sentTypes) { sentTypes.add(frame.string("type")) }; wire.put(frame)
                    if (frame.string("type") == "hello") {
                        webSocket.send("""{"type":"ready","v":1,"textRelay":true,"authRefresh":true}""")
                        webSocket.send("""{"type":"peer","online":true,"textRelay":false}""")
                    }
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            }))
            server.start(InetAddress.getByName("127.0.0.1"), 0)
            pairing = Pairing(server.url("/ws").toString().replace("http://", "ws://"), "a".repeat(32), "b".repeat(64), encodeBase64(ByteArray(32) { 9 }), "Fixture", System.currentTimeMillis() + 300_000)
            client = RemoteClient(PairedComputer(pairing, "phone-id", true, "7"), "fixture", "fixture-ticket", DirectPeerFactory { callback -> Peer(callback).also(peers::put) }, directTimeoutMs = timeout, onEvent = events::put)
        }
        fun start() {
            client.connect(); socket = sockets.poll(5, TimeUnit.SECONDS) ?: error("missing WS")
            hello = wire.poll(5, TimeUnit.SECONDS) ?: error("missing hello")
            peer = peers.poll(5, TimeUnit.SECONDS) ?: error("missing native adapter")
        }
        fun event(predicate: (ConnectionEvent) -> Boolean): ConnectionEvent {
            val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (System.nanoTime() < end) { val next = events.poll(100, TimeUnit.MILLISECONDS) ?: continue; if (predicate(next)) return next }
            error("missing expected event")
        }
        fun send(message: JsonObject) {
            val frame = wireJson.parseToJsonElement(cipher.seal(message)).jsonObject
            assertTrue(socket.send(JsonObject(frame + ("from" to text("desktop"))).toString()))
        }
        fun sendPart(message: JsonObject) = send(JsonObject(message + ("sentAt" to JsonPrimitive(System.currentTimeMillis()))))
        fun readPhone(): JsonObject {
            val frame = wire.poll(10, TimeUnit.SECONDS) ?: error("missing text frame")
            lastWireBytes = frame.toString().toByteArray(Charsets.UTF_8).size
            assertEquals("text", frame.string("type"))
            return cipher.open(JsonObject(frame + ("from" to text("phone"))))
        }
        fun textHandshake(epoch: String = "e".repeat(32)) {
            cipher = TextCipher(pairing, epoch, "desktop")
            assertTrue(socket.send(buildJsonObject { put("type", "peer"); put("online", true); put("textRelay", true); put("textEpoch", epoch) }.toString()))
            event { it is ConnectionEvent.WaitingForTransport }
            send(buildJsonObject { put("type", "text.ready"); put("challenge", "c".repeat(32)); put("sentAt", System.currentTimeMillis()) })
            assertEquals("c".repeat(32), readPhone().string("challenge"))
            assertEquals(epoch, (event { it is ConnectionEvent.TransportReady } as ConnectionEvent.TransportReady).epoch)
        }
        fun approve(logical: Boolean = false) {
            send(buildJsonObject { put("type", "pair.approved"); put("deviceId", "phone-id"); put("sentAt", System.currentTimeMillis())
                if (logical) { put("logicalJsonMaxBytes", LogicalJson.MAX_BYTES); put("logicalCodec", LogicalJson.CODEC) }
            })
            if (logical) assertEquals("client.hello", readPhone().string("type"))
            event { it is ConnectionEvent.Plaintext && it.message.string("type") == "pair.approved" }
        }
        override fun close() { client.close(); server.close() }
    }
}
