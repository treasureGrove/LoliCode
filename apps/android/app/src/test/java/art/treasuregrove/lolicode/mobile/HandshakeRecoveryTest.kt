package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

/** Deterministic real-loopback WS close overlap, without weakening the server's role ownership guard. */
class HandshakeRecoveryTest {
    @Test fun closingOldSocketCanRejectNewHelloThenBoundedHandshakeRecoveryReadsStatusOnly() {
        val server = MockWebServer()
        val active = AtomicReference<WebSocket?>(); val initial = AtomicReference<WebSocket?>()
        val holdInitialClose = AtomicBoolean(true)
        val oldAccepted = CountDownLatch(1); val oldClosing = CountDownLatch(1); val oldClosed = CountDownLatch(1)
        val methods = CopyOnWriteArrayList<String>()
        lateinit var pairing: Pairing
        lateinit var desktopCipher: TextCipher
        fun send(socket: WebSocket, body: JsonObject) {
            val sealed = wireJson.parseToJsonElement(desktopCipher.seal(body)).jsonObject
            socket.send(JsonObject(sealed + ("from" to text("desktop"))).toString())
        }
        val listener = object : WebSocketListener() {
            override fun onMessage(socket: WebSocket, value: String) {
                val frame = wireJson.parseToJsonElement(value).jsonObject
                if (frame.string("type") == "hello") {
                    if (!active.compareAndSet(null, socket)) { socket.send("""{"type":"error","code":"role_connected"}"""); return }
                    val first = initial.compareAndSet(null, socket)
                    socket.send("""{"type":"ready","v":1,"textRelay":true}""")
                    if (first) { oldAccepted.countDown(); return }
                    desktopCipher = TextCipher(pairing, "e".repeat(32), "desktop")
                    socket.send("""{"type":"peer","online":true,"textRelay":true,"textEpoch":"${"e".repeat(32)}"}""")
                    send(socket, buildJsonObject { put("type", "text.ready"); put("challenge", "c".repeat(32)); put("sentAt", System.currentTimeMillis()) })
                } else if (frame.string("type") == "text") {
                    val body = desktopCipher.open(JsonObject(frame + ("from" to text("phone"))))
                    if (body.string("type") == "text.ready") send(socket, buildJsonObject { put("type", "pair.approved"); put("deviceId", "phone-id"); put("sentAt", System.currentTimeMillis()) })
                    else if (body.string("type") == "request") {
                        methods.add(body.string("method"))
                        send(socket, buildJsonObject { put("type", "response"); put("requestId", body.string("requestId")); put("ok", true); put("sentAt", System.currentTimeMillis()); put("result", buildJsonObject { put("quietMode", true) }) })
                    }
                }
            }
            override fun onClosing(socket: WebSocket, code: Int, reason: String) {
                if (socket === initial.get() && holdInitialClose.get()) oldClosing.countDown()
                else socket.close(code, null)
            }
            override fun onClosed(socket: WebSocket, code: Int, reason: String) {
                active.compareAndSet(socket, null)
                if (socket === initial.get()) oldClosed.countDown()
            }
        }
        repeat(3) { server.enqueue(MockResponse().withWebSocketUpgrade(listener)) }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        pairing = Pairing(server.url("/ws").toString().replace("http://", "ws://"), "a".repeat(32), "b".repeat(64), encodeBase64(ByteArray(32) { 9 }), "Fixture", System.currentTimeMillis() + 300_000)
        val computer = PairedComputer(pairing, "phone-id", true, "7")
        val old = RemoteClient(computer, "fixture", "fixture-ticket", onEvent = {})
        val rejectedEvents = LinkedBlockingQueue<ConnectionEvent>()
        val rejected = RemoteClient(computer, "fixture", "fixture-ticket", onEvent = rejectedEvents::put)
        val recoveredEvents = LinkedBlockingQueue<ConnectionEvent>()
        val recovered = RemoteClient(computer, "fixture", "fixture-ticket", onEvent = recoveredEvents::put)
        try {
            old.connect(); assertTrue(oldAccepted.await(5, TimeUnit.SECONDS))
            old.close(); assertTrue(oldClosing.await(5, TimeUnit.SECONDS))
            rejected.connect()
            val closed = rejectedEvents.poll(5, TimeUnit.SECONDS) as ConnectionEvent.Closed
            assertEquals(ConnectionReasonCode.ROLE_CONNECTED, closed.reasonCode)
            assertTrue(closed.retryable); assertFalse(closed.authenticationRejected)
            // The later socket-close callback cannot overwrite the first diagnostic or trigger business replay.
            assertNull(rejectedEvents.poll(100, TimeUnit.MILLISECONDS))
            holdInitialClose.set(false); initial.get()!!.close(1000, null)
            assertTrue(oldClosed.await(5, TimeUnit.SECONDS))
            runBlocking { delay(handshakeRetryDelay(closed.reasonCode, 0)!!) }
            recovered.connect()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            var approved = false
            while (!approved && System.nanoTime() < deadline) {
                val event = recoveredEvents.poll(100, TimeUnit.MILLISECONDS)
                approved = event is ConnectionEvent.Plaintext && event.message.string("type") == "pair.approved"
            }
            assertTrue(approved)
            val result = runBlocking { withTimeout(5000) { recovered.request("status") } }.jsonObject
            assertTrue(result.boolean("quietMode")); assertEquals(listOf("status"), methods)
        } finally {
            holdInitialClose.set(false); initial.get()?.close(1000, null)
            old.close(); rejected.close(); recovered.close(); server.close()
        }
    }

    @Test fun onlyTemporaryHandshakeReasonsHaveThreeFiniteRetries() {
        for (reason in listOf(ConnectionReasonCode.ROLE_CONNECTED, ConnectionReasonCode.PEER_NOT_READY)) {
            assertEquals(listOf(500L, 1000L, 2000L), (0..2).map { handshakeRetryDelay(reason, it) })
            assertNull(handshakeRetryDelay(reason, 3)); assertNull(handshakeRetryDelay(reason, -1))
        }
        for (reason in ConnectionReasonCode.entries.filterNot { it in setOf(ConnectionReasonCode.ROLE_CONNECTED, ConnectionReasonCode.PEER_NOT_READY) }) assertNull(handshakeRetryDelay(reason, 0))
    }
}
