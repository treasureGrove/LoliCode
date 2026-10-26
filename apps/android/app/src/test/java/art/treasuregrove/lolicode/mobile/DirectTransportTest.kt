package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.IOException
import java.net.InetAddress
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

/** Real local control socket, fake native adapter. Native ICE is tested separately. */
class DirectTransportTest {
    @Test fun accountTasksWaitForTheNativeChannelAndNeverUseTheControlSocket() {
        Harness().use { h ->
            val peer = h.startNative()
            assertThrows(IllegalStateException::class.java) { runBlocking { h.client.request("status") } }
            val offerId = h.offer(peer)
            // A stale native callback cannot emit an answer for another offer.
            peer.events.answer(UUID.randomUUID().toString(), validSdp())
            peer.events.answer(offerId, validSdp())
            val signal = h.nextWire()
            assertEquals("signal", signal.string("type"))
            val answer = DirectSignalCipher(h.pairing, "desktop").open(JsonObject(signal + ("from" to text("phone"))))
            assertEquals("direct.answer", answer.string("type"))
            assertEquals(offerId, answer.string("negotiationId"))
            assertThrows(IllegalStateException::class.java) { runBlocking { h.client.request("status") } }
            peer.events.opened()
            assertEquals(ConnectionEvent.Ready, h.nextEvent())

            val privateMarker = "fixture-task-body-that-must-not-reach-the-control-service"
            val result = runBlocking {
                val pending = async(Dispatchers.Default) { h.client.request("status", buildJsonObject { put("fixture", privateMarker) }) }
                val packet = wireJson.parseToJsonElement(peer.sent.poll(5, TimeUnit.SECONDS) ?: error("missing native packet")).jsonObject
                assertEquals("packet", packet.string("type"))
                assertEquals("phone", packet.string("from"))
                val command = h.decryptPhone(packet)
                assertEquals("status", command.string("method"))
                assertEquals(privateMarker, command.getValue("params").jsonObject.string("fixture"))
                peer.events.frame(h.desktopPacket(buildJsonObject {
                    put("type", "response"); put("requestId", command.string("requestId")); put("ok", true)
                    put("sentAt", System.currentTimeMillis())
                    put("result", buildJsonObject { put("protocol", 1); put("quietMode", true) })
                }).toString())
                withTimeout(5_000) { pending.await() }
            }.jsonObject
            assertTrue(result.boolean("quietMode"))
            assertEquals(1L, result.long("protocol"))
            assertEquals(listOf("hello", "signal"), h.history.map { it.string("type") })
            assertTrue(h.history.none { it.toString().contains(privateMarker) })
            assertTrue(h.history.none { it.string("type") == "packet" })
        }
    }

    @Test fun unsupportedOrFailedNativeTransportFailsClosedWithoutTaskFallback() {
        Harness(factoryEnabled = false).use { h ->
            h.connect()
            val closed = h.nextEvent() as ConnectionEvent.Closed
            assertFalse(closed.retryable)
            assertThrows(IllegalStateException::class.java) { runBlocking { h.client.request("status") } }
            assertEquals(listOf("hello"), h.history.map { it.string("type") })
        }
        Harness().use { h ->
            val peer = h.startNative()
            peer.events.failed()
            val closed = h.nextEvent() as ConnectionEvent.Closed
            assertFalse(closed.retryable)
            assertEquals("直连不可用，请切换网络后重试", closed.reason)
            assertEquals(1, peer.closed.get())
            assertThrows(IllegalStateException::class.java) { runBlocking { h.client.request("status") } }
            assertTrue(h.history.none { it.string("type") == "packet" })
        }
    }

    @Test fun peerOfflineSocketRevocationAndNativeFailureCloseThePeerAndPendingRequests() {
        listOf("offline", "revoked", "native-failed").forEach { reason ->
            Harness().use { h ->
                val peer = h.openDirect()
                val result = runBlocking {
                    val pending = async(Dispatchers.Default) { runCatching { h.client.request("status") } }
                    assertNotNull(peer.sent.poll(5, TimeUnit.SECONDS))
                    when (reason) {
                        "offline" -> assertTrue(h.socket().send("""{"type":"peer","online":false}"""))
                        "revoked" -> assertTrue(h.socket().close(4003, "fixture-revocation"))
                        else -> peer.events.failed()
                    }
                    withTimeout(5_000) { pending.await() }
                }
                assertTrue("pending request must fail on $reason", result.exceptionOrNull() is IOException)
                val closed = h.nextEvent() as ConnectionEvent.Closed
                if (reason == "revoked") assertTrue(closed.authenticationRejected)
                if (reason == "native-failed") assertFalse(closed.retryable)
                assertEquals(1, peer.closed.get())
                assertTrue(h.history.none { it.string("type") == "packet" })
            }
        }
    }

    @Test fun aSecondOfferCannotReplaceTheCurrentWebSocketNegotiation() {
        listOf(false, true).forEach { foreign ->
            Harness().use { h ->
                val peer = h.openDirect()
                val secondId = if (foreign) UUID.randomUUID().toString() else h.negotiation
                h.sendOffer(secondId)
                val closed = h.nextEvent() as ConnectionEvent.Closed
                assertFalse(closed.retryable)
                assertEquals(1, peer.closed.get())
                assertNull(peer.offers.poll())
                assertTrue(h.history.none { it.string("type") == "packet" })
            }
        }
    }

    @Test fun anAuthenticatedTaskPacketOnTheControlSocketIsStillRejected() {
        Harness().use { h ->
            val peer = h.openDirect()
            val packet = h.desktopPacket(buildJsonObject { put("type", "event"); put("event", "fixture"); put("sentAt", System.currentTimeMillis()) })
            assertTrue(h.socket().send(packet.toString()))
            val closed = h.nextEvent() as ConnectionEvent.Closed
            assertFalse(closed.retryable)
            assertEquals(1, peer.closed.get())
            assertTrue(h.history.none { it.string("type") == "packet" })
        }
    }

    @Test fun nativePacketTamperWrongRoleAndReplayCloseTheConnection() {
        listOf("tamper", "role", "replay").forEach { attempt ->
            Harness().use { h ->
                val peer = h.openDirect()
                val event = buildJsonObject { put("type", "event"); put("event", "fixture"); put("sentAt", System.currentTimeMillis()) }
                val valid = h.desktopPacket(event)
                val bad = when (attempt) {
                    "tamper" -> {
                        val ciphertext = decodeBase64(valid.string("ciphertext")).also { it[0] = (it[0].toInt() xor 1).toByte() }
                        JsonObject(valid + ("ciphertext" to text(encodeBase64(ciphertext))))
                    }
                    "role" -> JsonObject(valid + ("from" to text("phone")))
                    else -> {
                        peer.events.frame(valid.toString())
                        assertEquals(event, (h.nextEvent() as ConnectionEvent.Plaintext).message)
                        valid
                    }
                }
                peer.events.frame(bad.toString())
                val closed = h.nextEvent() as ConnectionEvent.Closed
                assertFalse(closed.retryable)
                assertEquals(1, peer.closed.get())
                assertTrue(h.history.none { it.string("type") == "packet" })
            }
        }
    }

    private class FakePeer(val events: DirectPeerEvents) : DirectPeer {
        val offers = LinkedBlockingQueue<Pair<String, String>>()
        val sent = LinkedBlockingQueue<String>()
        val closed = AtomicInteger()
        override fun acceptOffer(negotiationId: String, sdp: String) { offers.put(negotiationId to sdp) }
        override fun send(frame: String): Boolean { sent.put(frame); return true }
        override fun close() { closed.incrementAndGet() }
    }

    private class Harness(factoryEnabled: Boolean = true) : AutoCloseable {
        private val server = MockWebServer()
        private val wire = LinkedBlockingQueue<JsonObject>()
        private val events = LinkedBlockingQueue<ConnectionEvent>()
        private val serverSocket = LinkedBlockingQueue<WebSocket>()
        private val peers = LinkedBlockingQueue<FakePeer>()
        private var activeSocket: WebSocket? = null
        val history = CopyOnWriteArrayList<JsonObject>()
        private val key = ByteArray(32) { (it + 10).toByte() }
        val negotiation = UUID.randomUUID().toString()
        val pairing: Pairing
        val client: RemoteClient
        init {
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { serverSocket.put(webSocket) }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = wireJson.parseToJsonElement(text).jsonObject
                    history.add(frame); wire.put(frame)
                    if (frame.string("type") == "hello") {
                        webSocket.send("""{"type":"ready","v":1}""")
                        webSocket.send("""{"type":"peer","online":true}""")
                    }
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            }))
            server.start(InetAddress.getByName("127.0.0.1"), 0)
            val url = server.url("/companion/ws").newBuilder().host("127.0.0.1").build().toString().replace("http://", "ws://")
            pairing = Pairing(url, "a".repeat(32), "b".repeat(64), encodeBase64(key), "Fixture desktop", System.currentTimeMillis() + 300_000)
            val computer = PairedComputer(pairing, "00000000-0000-4000-8000-000000000002", approved = true, accountId = "7",
                desktopDeviceId = "00000000-0000-4000-8000-000000000001", desktopFingerprint = "c".repeat(64))
            val factory = if (factoryEnabled) DirectPeerFactory { callback -> FakePeer(callback).also { peers.put(it) } } else null
            client = RemoteClient(computer, "Fixture phone", "fixture_device_ticket_${"d".repeat(32)}", factory, events::put)
        }
        fun connect() {
            client.connect()
            val hello = nextWire()
            assertEquals("hello", hello.string("type"))
            assertTrue(hello.string("deviceToken").startsWith("fixture_device_ticket_"))
            activeSocket = serverSocket.poll(5, TimeUnit.SECONDS) ?: error("missing local socket")
        }
        fun startNative(): FakePeer {
            connect()
            val peer = peers.poll(5, TimeUnit.SECONDS) ?: error("missing native adapter")
            assertEquals(ConnectionEvent.Peer(true), nextEvent())
            return peer
        }
        fun offer(peer: FakePeer): String {
            sendOffer(negotiation)
            assertEquals(negotiation to validSdp(), peer.offers.poll(5, TimeUnit.SECONDS))
            return negotiation
        }
        fun sendOffer(id: String) {
            val offer = buildJsonObject { put("type", "direct.offer"); put("negotiationId", id); put("sdp", validSdp()); put("sentAt", System.currentTimeMillis()) }
            val frame = wireJson.parseToJsonElement(DirectSignalCipher(pairing, "desktop").seal(offer)).jsonObject
            assertTrue(socket().send(JsonObject(frame + ("from" to text("desktop"))).toString()))
        }
        fun openDirect(): FakePeer {
            val peer = startNative()
            offer(peer)
            peer.events.answer(negotiation, validSdp())
            assertEquals("signal", nextWire().string("type"))
            peer.events.opened()
            assertEquals(ConnectionEvent.Ready, nextEvent())
            return peer
        }
        fun socket(): WebSocket = activeSocket ?: error("local socket not connected")
        fun nextWire(): JsonObject = wire.poll(5, TimeUnit.SECONDS) ?: error("missing control frame")
        fun nextEvent(): ConnectionEvent = events.poll(5, TimeUnit.SECONDS) ?: error("missing connection event")
        fun decryptPhone(packet: JsonObject): JsonObject {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, decodeBase64(packet.string("nonce"))))
            cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|phone|${packet.string("id")}".toByteArray())
            return wireJson.parseToJsonElement(String(cipher.doFinal(decodeBase64(packet.string("ciphertext"))))).jsonObject
        }
        fun desktopPacket(message: JsonObject): JsonObject {
            val id = UUID.randomUUID().toString()
            val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|desktop|$id".toByteArray())
            return buildJsonObject { put("type", "packet"); put("v", 1); put("id", id); put("from", "desktop"); put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(message.toString().toByteArray()))) }
        }
        override fun close() { client.close(); server.close() }
    }

    companion object {
        private fun validSdp() = listOf(
            "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE data",
            "a=fingerprint:sha-256 ${List(32) { "AB" }.joinToString(":")}",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", "a=mid:data", "a=sctp-port:5000",
        ).joinToString("\r\n", postfix = "\r\n")
    }
}
