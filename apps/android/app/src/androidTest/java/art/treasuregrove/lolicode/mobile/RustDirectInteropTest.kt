package art.treasuregrove.lolicode.mobile

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit opt-in. adb reverse carries only HTTP SDP; native task bytes use UDP. */
@RunWith(AndroidJUnit4::class)
class RustDirectInteropTest {
    @Test fun exchangesTwentyKiBWithTheNativeRustPeer() {
        assumeTrue(BuildConfig.ALLOW_LOCAL_RELAY && InstrumentationRegistry.getArguments().getString("nativeInterop") == "1")
        val client = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
        val offer = client.newCall(Request.Builder().url("http://127.0.0.1:3127/offer").build()).execute().use { response ->
            check(response.isSuccessful)
            val body = response.body!!.string(); check(body.toByteArray().size <= 16 * 1024)
            wireJson.parseToJsonElement(body).jsonObject
        }
        check(offer.string("roomId") == "f".repeat(32) && offer.string("testKey") == encodeBase64(ByteArray(32) { 42 }))
        validateDirectSdp(offer.string("sdp"))
        val pairing = Pairing("wss://fixture.invalid/companion/ws", offer.string("roomId"), "b".repeat(64), offer.string("testKey"), "Rust fixture", System.currentTimeMillis() + 300_000)
        val cipher = PacketCipher(pairing)
        val complete = CountDownLatch(1); val errors = LinkedBlockingQueue<String>()
        val directBytes = AtomicLong(0); val httpRequests = AtomicLong(1)
        var sawPing = false
        var phone: NativeDirectPeer? = null
        try {
            phone = NativeDirectPeer(InstrumentationRegistry.getInstrumentation().targetContext, object : DirectPeerEvents {
                override fun answer(negotiationId: String, sdp: String) {
                    try {
                        validateDirectSdp(sdp)
                        val body = buildJsonObject { put("sdp", sdp) }.toString()
                        httpRequests.incrementAndGet()
                        client.newCall(Request.Builder().url("http://127.0.0.1:3127/answer").post(body.toRequestBody("application/json".toMediaType())).build()).execute().use { check(it.isSuccessful) }
                    } catch (_: Exception) { errors.offer("test SDP HTTP failed"); complete.countDown() }
                }
                override fun opened() = Unit
                override fun frame(frame: String) {
                    try {
                        directBytes.addAndGet(frame.toByteArray().size.toLong())
                        val message = cipher.open(wireJson.parseToJsonElement(frame).jsonObject)
                        when (message.string("type")) {
                            "interop.ping" -> {
                                check(!sawPing && message.string("body") == "x".repeat(20_480)); sawPing = true
                                val reply = buildJsonObject { put("type", "interop.pong"); put("body", "y".repeat(20_480)); put("sentAt", System.currentTimeMillis()) }
                                val packet = wireJson.parseToJsonElement(cipher.seal(reply)).jsonObject
                                val wire = JsonObject(packet + ("from" to text("phone"))).toString()
                                directBytes.addAndGet(wire.toByteArray().size.toLong())
                                check(phone!!.send(wire))
                            }
                            "interop.ok" -> { check(sawPing); complete.countDown() }
                            else -> error("unknown fixture packet")
                        }
                    } catch (_: Exception) { errors.offer("native Rust fixture rejected"); complete.countDown() }
                }
                override fun failed() { errors.offer("native Rust connection failed"); complete.countDown() }
            }, stunUrls = if (InstrumentationRegistry.getArguments().getString("nativeInteropStun") == "1") listOf("stun:lolicode.com:3478") else emptyList())
            phone.acceptOffer(UUID.randomUUID().toString(), offer.string("sdp"))
            assertTrue("cross-platform direct timeout", complete.await(40, TimeUnit.SECONDS))
            assertTrue(errors.peek(), errors.isEmpty())
            assertTrue(sawPing)
            assertEquals(2L, httpRequests.get())
            assertTrue(directBytes.get() > 40_960)
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("rustDirectInterop", "AndroidNative<->RustNative; ping=20480; pong=20480; directEncryptedBytes=${directBytes.get()}; httpSignalingRequests=2; taskWebSocketBytes=0; TURN=disabled")
            })
        } finally { phone?.close() }
    }
}
