package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

/** Local HTTP/enrollment integration. No real account or task is contacted. */
class AccountRelayTest {
    @Test fun loginDiscoversAndDecryptsTheExplicitlyApprovedComputer() {
        val f = AccountFixture()
        val server = localServer()
        val origin = localOrigin(server)
        val websocket = origin.resolve("companion/ws")!!.toString().replace("http://", "ws://")
        val pairing = JsonObject(f.pairing + ("relayUrl" to text(websocket)))
        val approved = f.request.copy(envelope = f.envelopeFor(JsonObject(f.plaintext + ("pairing" to pairing))))
        val pending = approved.copy(status = "pending", roomId = null, envelope = null)
        val capability = "device_only_${"b".repeat(40)}"
        val greeting = LinkedBlockingQueue<JsonObject>()
        val events = LinkedBlockingQueue<ConnectionEvent>()
        server.enqueue(json(buildJsonObject { put("userId", f.request.accountId); put("token", FORUM_TOKEN) }))
        server.enqueue(json(selfProfile(f.request.accountId)))
        server.enqueue(json(sessionJson(f, capability)))
        server.enqueue(json(buildJsonObject { put("devices", JsonArray(listOf(f.deviceJson(f.phone), f.deviceJson(f.desktop)))) }))
        server.enqueue(json(f.requestJson(pending)))
        server.enqueue(json(f.requestJson(approved)))
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                greeting.put(wireJson.parseToJsonElement(text).jsonObject)
                webSocket.send("""{"type":"ready","v":1}""")
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
        }))
        var transport: RemoteClient? = null
        try {
            val credential = ForumIdentity(origin, allowLocal = true).login("fixture", "one-time-fictional-password")
            val relay = AccountRelay(origin.resolve("v2/")!!, websocket, allowLocal = true)
            val session = relay.session(credential, f.phone.deviceId, "Fixture phone", f.identity, f.now)
            assertEquals(listOf(f.desktop), relay.devices(session))
            val request = relay.request(session, f.desktop.deviceId)
            assertEquals("pending", request.status)
            val approval = relay.request(session, request)
            val computer = openEnrollment(approval, credential.account.id, f.phone.deviceId, f.identity,
                f.desktop, request.requestId, websocket, f.now, allowLocal = true)
            assertTrue(computer.approved)
            assertEquals(credential.account.id, computer.accountId)
            assertEquals(f.desktop.fingerprint, computer.desktopFingerprint)
            assertEquals(pairing, computer.pairing.toJson())

            // Authentication/signaling uses the room role token plus the short
            // device capability. This does not assert that account tasks use WSS.
            transport = RemoteClient(computer, "Fixture phone", session.deviceToken, events::put)
            transport.connect()
            val hello = greeting.poll(5, TimeUnit.SECONDS) ?: error("missing local hello")
            assertEquals("hello", hello.string("type"))
            assertEquals("phone", hello.string("role"))
            assertEquals(computer.id, hello.string("roomId"))
            assertEquals(capability, hello.string("deviceToken"))
            assertEquals(computer.pairing.phoneToken, hello.string("token"))
            assertFalse(hello.toString().contains(FORUM_TOKEN))
            assertFalse(hello.containsKey("phoneToken"))
            assertFalse(hello.containsKey("key"))

            val tokenRequest = take(server)
            assertEquals("/api/token", tokenRequest.path)
            assertNull(tokenRequest.getHeader("Authorization"))
            assertEquals("Token $FORUM_TOKEN", take(server).getHeader("Authorization"))
            val registration = take(server)
            assertEquals("/v2/session", registration.path)
            assertEquals("Bearer ${credential.bearer}", registration.getHeader("Authorization"))
            val registered = wireJson.parseToJsonElement(registration.body.readUtf8()).jsonObject
            assertEquals(f.phone.publicKey, registered.string("publicKey"))
            assertFalse(registered.containsKey("privateKey"))
            assertFalse(registered.containsKey("password"))
            assertDeviceRequest(take(server), "/v2/devices", capability)
            val connection = take(server)
            assertDeviceRequest(connection, "/v2/requests", capability)
            assertEquals(f.desktop.deviceId, wireJson.parseToJsonElement(connection.body.readUtf8()).jsonObject.string("desktopDeviceId"))
            assertDeviceRequest(take(server), "/v2/requests/${request.requestId}", capability)
            assertEquals("/companion/ws", take(server).path)

            // The envelope's key really encrypts/decrypts v1 packet data; no task
            // is dispatched through a transport in this primitive-level check.
            val packetCipher = PacketCipher(computer.pairing) { f.now }
            val command = buildJsonObject { put("type", "request"); put("method", "status"); put("requestId", "fixture-status"); put("sentAt", f.now) }
            val encrypted = wireJson.parseToJsonElement(packetCipher.seal(command)).jsonObject
            assertFalse(encrypted.toString().contains("fixture-status"))
            assertEquals(command, decryptPhone(encrypted, computer.pairing))
            val response = buildJsonObject { put("type", "response"); put("requestId", "fixture-status"); put("ok", true); put("sentAt", f.now); put("result", buildJsonObject { put("quietMode", true); put("protocol", 1) }) }
            assertEquals(response, packetCipher.open(encryptDesktop(response, computer.pairing)))
        } finally { transport?.close(); server.close() }
    }

    @Test fun expiredDeviceCapabilitiesCanBeReplacedWithoutUsingForumTokensAsDeviceTickets() {
        val f = AccountFixture()
        val server = localServer()
        val firstToken = "old_${"a".repeat(40)}"
        val secondToken = "renewed_${"b".repeat(40)}"
        server.enqueue(json(sessionJson(f, firstToken)))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"session_expired","message":"Session expired"}}"""))
        server.enqueue(json(sessionJson(f, secondToken)))
        server.enqueue(json(buildJsonObject { put("devices", JsonArray(listOf(f.deviceJson(f.desktop)))) }))
        try {
            val relay = AccountRelay(localOrigin(server).resolve("v2/")!!, allowLocal = true)
            val credential = ForumCredential(AccountProfile(f.request.accountId, "fixture", "Fixture"), FORUM_TOKEN)
            val first = relay.session(credential, f.phone.deviceId, "Fixture phone", f.identity, f.now)
            assertFalse(first.needsRenewal(f.now))
            assertTrue(first.needsRenewal(first.expiresAt - 60_000))
            assertTrue(first.needsRenewal(first.expiresAt))
            assertThrows(AccountExpired::class.java) { relay.devices(first) }
            val renewed = relay.session(credential, f.phone.deviceId, "Fixture phone", f.identity, f.now)
            assertNotEquals(first.deviceToken, renewed.deviceToken)
            assertEquals(listOf(f.desktop), relay.devices(renewed))
            assertEquals("Bearer ${credential.bearer}", take(server).getHeader("Authorization"))
            assertDeviceRequest(take(server), "/v2/devices", firstToken)
            assertEquals("Bearer ${credential.bearer}", take(server).getHeader("Authorization"))
            assertDeviceRequest(take(server), "/v2/devices", secondToken)
        } finally { server.close() }
    }

    @Test fun registrationRejectsForeignAccountsDevicesRolesKeysAndUnboundedTickets() {
        val f = AccountFixture()
        val good = sessionJson(f, "capability_${"a".repeat(40)}")
        val wrongDevice = f.phone.copy(deviceId = "00000000-0000-4000-8000-000000000099")
        val wrongRole = f.phone.copy(kind = "desktop")
        val wrongKey = f.phone.copy(publicKey = f.desktop.publicKey, fingerprint = f.desktop.fingerprint)
        val attempts = listOf(
            JsonObject(good + ("accountId" to text("8"))),
            JsonObject(good + ("device" to f.deviceJson(wrongDevice))),
            JsonObject(good + ("device" to f.deviceJson(wrongRole))),
            JsonObject(good + ("device" to f.deviceJson(wrongKey))),
            JsonObject(good + ("expiresAt" to JsonPrimitive(f.now))),
            JsonObject(good + ("expiresAt" to JsonPrimitive(f.now + 1_000_000))),
            JsonObject(good + ("deviceToken" to text("short"))),
        )
        val server = localServer()
        attempts.forEach { server.enqueue(json(it)) }
        try {
            val relay = AccountRelay(localOrigin(server).resolve("v2/")!!, allowLocal = true)
            val credential = ForumCredential(AccountProfile(f.request.accountId, "fixture", "Fixture"), FORUM_TOKEN)
            attempts.forEach { assertThrows(IllegalArgumentException::class.java) { relay.session(credential, f.phone.deviceId, "Fixture phone", f.identity, f.now) } }
        } finally { server.close() }
    }

    private fun selfProfile(id: String) = buildJsonObject {
        put("data", buildJsonObject { put("type", "users"); put("id", id); put("attributes", buildJsonObject {
            put("username", "fixture"); put("displayName", "Fixture"); put("email", "fixture@example.invalid"); put("isEmailConfirmed", true); put("isAdmin", false)
        }) })
    }
    private fun sessionJson(f: AccountFixture, token: String) = buildJsonObject {
        put("v", 2); put("accountId", f.request.accountId); put("deviceToken", token)
        put("expiresAt", f.now + 900_000); put("device", f.deviceJson(f.phone))
    }
    private fun localServer() = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private fun localOrigin(server: MockWebServer): HttpUrl = server.url("/").newBuilder().host("127.0.0.1").build()
    private fun json(value: JsonObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())
    private fun take(server: MockWebServer): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS) ?: error("missing local HTTP request")
    private fun assertDeviceRequest(request: RecordedRequest, path: String, token: String) {
        assertEquals(path, request.path)
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        assertFalse(request.getHeader("Authorization").orEmpty().contains(FORUM_TOKEN))
    }
    private fun decryptPhone(packet: JsonObject, pairing: Pairing): JsonObject {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, decodeBase64(packet.string("nonce"))))
        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|phone|${packet.string("id")}".toByteArray())
        return wireJson.parseToJsonElement(String(cipher.doFinal(decodeBase64(packet.string("ciphertext"))))).jsonObject
    }
    private fun encryptDesktop(message: JsonObject, pairing: Pairing): JsonObject {
        val id = UUID.randomUUID().toString()
        val nonce = ByteArray(12) { (it + 3).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|desktop|$id".toByteArray())
        return buildJsonObject { put("type", "packet"); put("v", 1); put("from", "desktop"); put("id", id); put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(message.toString().toByteArray()))) }
    }
    companion object { private val FORUM_TOKEN = "f".repeat(40) }
}
