package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

class RemoteClientTest {
    @Test fun authenticatesPhoneThenExchangesEncryptedRequestAndResponse() {
        val server = MockWebServer()
        val events = LinkedBlockingQueue<ConnectionEvent>()
        val requests = LinkedBlockingQueue<JsonObject>()
        val room = "a".repeat(32)
        val token = "b".repeat(64)
        val key = ByteArray(32) { it.toByte() }
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = wireJson.parseToJsonElement(text).jsonObject
                if (frame.string("type") == "hello") {
                    requests.put(frame)
                    webSocket.send("""{"type":"ready","v":1}""")
                    webSocket.send("""{"type":"peer","online":true}""")
                } else if (frame.string("type") == "packet") {
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, decodeBase64(frame.string("nonce"))))
                    cipher.updateAAD("lolicode-companion/1|$room|phone|${frame.string("id")}".toByteArray())
                    val message = wireJson.parseToJsonElement(String(cipher.doFinal(decodeBase64(frame.string("ciphertext"))))).jsonObject
                    requests.put(message)
                    val response = buildJsonObject {
                        put("type", "response"); put("requestId", message.string("requestId")); put("ok", true)
                        put("result", buildJsonObject { put("hostName", "电脑"); put("quietMode", true); put("protocol", 1) })
                        put("sentAt", System.currentTimeMillis())
                    }
                    webSocket.send(encryptDesktop(response, room, key))
                }
            }
        }))
        server.start()
        val pairing = Pairing(server.url("/companion").toString().replace("http:", "ws:"), room, token, encodeBase64(key), "电脑", System.currentTimeMillis() + 300_000)
        val client = RemoteClient(PairedComputer(pairing, "phone", true), onEvent = events::put)
        try {
            client.connect()
            assertEquals(ConnectionEvent.Ready, events.poll(10, TimeUnit.SECONDS))
            assertEquals(ConnectionEvent.Peer(true), events.poll(10, TimeUnit.SECONDS))
            val greeting = requests.poll(10, TimeUnit.SECONDS)
            assertEquals("phone", greeting.string("role"))
            assertEquals(token, greeting.string("token"))
            val result = runBlocking { client.request("status") }.jsonObject
            assertTrue(result.boolean("quietMode"))
            val command = requests.poll(10, TimeUnit.SECONDS)
            assertEquals("status", command.string("method"))
            assertTrue(command.string("requestId").isNotBlank())
            assertFalse(command.containsKey("phoneToken"))
        } finally { client.close(); server.close() }
    }

    @Test fun expiredSavedPendingPairingReconnectsAndConfirmsDesktopApproval() {
        val server = MockWebServer()
        val events = LinkedBlockingQueue<ConnectionEvent>()
        val request = LinkedBlockingQueue<JsonObject>()
        val room = "c".repeat(32)
        val key = ByteArray(32) { (it + 2).toByte() }
        var desktopOnline = false
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = wireJson.parseToJsonElement(text).jsonObject
                if (frame.string("type") == "hello") {
                    webSocket.send("""{"type":"ready","v":1}""")
                    webSocket.send("""{"type":"peer","online":false}""")
                } else if (frame.string("type") == "packet") {
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, decodeBase64(frame.string("nonce"))))
                    cipher.updateAAD("lolicode-companion/1|$room|phone|${frame.string("id")}".toByteArray())
                    val plaintext = wireJson.parseToJsonElement(String(cipher.doFinal(decodeBase64(frame.string("ciphertext"))))).jsonObject
                    request.put(plaintext)
                    if (!desktopOnline) {
                        // The phone is ready before its desktop reconnects.
                        // Peer availability must re-confirm the pending room.
                        desktopOnline = true
                        webSocket.send("""{"type":"peer","online":true}""")
                        return
                    }
                    // The desktop approved this phone while it was stopped, so
                    // it confirms that existing approval despite QR expiry.
                    webSocket.send(encryptDesktop(buildJsonObject {
                        put("type", "pair.approved"); put("deviceId", "saved-phone")
                        put("hostName", "电脑"); put("sentAt", System.currentTimeMillis())
                    }, room, key))
                }
            }
        }))
        server.start()
        val expired = Pairing(server.url("/companion").toString().replace("http:", "ws:"), room, "d".repeat(64), encodeBase64(key), "电脑", System.currentTimeMillis() - 600_000)
        // New import must still fail; credentials already saved on the phone
        // must survive expiry, with approved=false until the desktop confirms.
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(expired.toJson().toString(), allowLocal = true) }
        val restored = Pairing.parse(expired.toJson().toString(), allowLocal = true, enrollment = false)
        val client = RemoteClient(PairedComputer(restored, "saved-phone", approved = false), "Redmi test", events::put)
        try {
            client.connect()
            assertEquals(ConnectionEvent.Ready, events.poll(10, TimeUnit.SECONDS))
            assertEquals(ConnectionEvent.Peer(false), events.poll(10, TimeUnit.SECONDS))
            assertEquals(ConnectionEvent.Peer(true), events.poll(10, TimeUnit.SECONDS))
            val pairingRequest = request.poll(10, TimeUnit.SECONDS)
            assertEquals("pair.request", pairingRequest.string("type"))
            assertEquals("saved-phone", pairingRequest.string("deviceId"))
            assertEquals("Redmi test", pairingRequest.string("deviceName"))
            assertEquals("pair.request", request.poll(10, TimeUnit.SECONDS).string("type"))
            val approval = events.poll(10, TimeUnit.SECONDS) as ConnectionEvent.Plaintext
            assertEquals("pair.approved", approval.message.string("type"))
            assertEquals("saved-phone", approval.message.string("deviceId"))
        } finally { client.close(); server.close() }
    }

    private fun encryptDesktop(message: JsonObject, room: String, key: ByteArray): String {
        val id = UUID.randomUUID().toString()
        val nonce = ByteArray(12) { (it + 1).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("lolicode-companion/1|$room|desktop|$id".toByteArray())
        return buildJsonObject {
            put("type", "packet"); put("v", 1); put("id", id); put("from", "desktop")
            put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(message.toString().toByteArray())))
        }.toString()
    }
}
