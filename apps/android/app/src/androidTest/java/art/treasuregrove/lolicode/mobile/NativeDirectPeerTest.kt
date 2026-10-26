package art.treasuregrove.lolicode.mobile

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.*

/** Two actual native peers on the device. Signaling is in memory; data uses UDP. */
@RunWith(AndroidJUnit4::class)
class NativeDirectPeerTest {
    @Test fun nativeHostCandidatesExchangeAnAuthenticatedPacketWithoutTaskRelay() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        NativeDirectPeer.initialize(context)
        val errors = LinkedBlockingQueue<String>()
        val opened = CountDownLatch(2)
        val received = LinkedBlockingQueue<JsonObject>()
        val signalBytes = AtomicLong(0); val dataBytes = AtomicLong(0)
        val signaling = mutableListOf<String>()
        val offerPublished = AtomicBoolean(false)
        val negotiation = UUID.randomUUID().toString()
        val pairing = Pairing("wss://fixture.invalid/companion/ws", "a".repeat(32), "b".repeat(64), encodeBase64(ByteArray(32) { (it + 7).toByte() }), "Native fixture", System.currentTimeMillis() + 300_000)
        val phoneCipher = PacketCipher(pairing)
        val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        var desktop: PeerConnection? = null
        var phone: NativeDirectPeer? = null
        var channel: DataChannel? = null
        fun recordSignal(sdp: String) { validateDirectSdp(sdp); synchronized(signaling) { signaling += sdp }; signalBytes.addAndGet(sdp.toByteArray().size.toLong()) }
        fun publishOffer() {
            val local = desktop?.localDescription ?: return
            if (offerPublished.compareAndSet(false, true)) {
                try { recordSignal(local.description); phone!!.acceptOffer(negotiation, local.description) }
                catch (_: Exception) { errors.offer("offer rejected") }
            }
        }
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { if (state == PeerConnection.IceConnectionState.FAILED) errors.offer("desktop ICE failed") }
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) publishOffer() }
            override fun onIceCandidate(candidate: IceCandidate) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit
            override fun onDataChannel(channel: DataChannel) { errors.offer("unexpected extra channel") }
            override fun onRenegotiationNeeded() = Unit
        }
        try {
            phone = NativeDirectPeer(context, object : DirectPeerEvents {
                override fun answer(negotiationId: String, sdp: String) {
                    try {
                        check(negotiationId == negotiation); recordSignal(sdp)
                        desktop!!.setRemoteDescription(sdpObserver(errors), SessionDescription(SessionDescription.Type.ANSWER, sdp))
                    } catch (_: Exception) { errors.offer("answer rejected") }
                }
                override fun opened() { opened.countDown() }
                override fun frame(frame: String) {
                    try {
                        dataBytes.addAndGet(frame.toByteArray().size.toLong())
                        val command = phoneCipher.open(wireJson.parseToJsonElement(frame).jsonObject)
                        check(command.string("method") == "status")
                        val reply = buildJsonObject {
                            put("type", "response"); put("requestId", command.string("requestId")); put("ok", true)
                            put("result", buildJsonObject { put("marker", MARKER); put("quietMode", true); put("protocol", 1) }); put("sentAt", System.currentTimeMillis())
                        }
                        val packet = wireJson.parseToJsonElement(phoneCipher.seal(reply)).jsonObject
                        check(phone!!.send(JsonObject(packet + ("from" to text("phone"))).toString()))
                    } catch (_: Exception) { errors.offer("phone packet rejected") }
                }
                override fun failed() { errors.offer("phone native failed") }
            }, stunUrls = emptyList())
            desktop = factory.createPeerConnection(PeerConnection.RTCConfiguration(emptyList()).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            }, observer)!!
            channel = desktop!!.createDataChannel(NativeDirectPeer.CHANNEL_LABEL, DataChannel.Init().apply {
                ordered = true; negotiated = false; protocol = NativeDirectPeer.CHANNEL_PROTOCOL
            })
            channel!!.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
                override fun onStateChange() { if (channel!!.state() == DataChannel.State.OPEN) opened.countDown() }
                override fun onMessage(buffer: DataChannel.Buffer) {
                    try {
                        check(!buffer.binary)
                        val bytes = ByteArray(buffer.data.remaining()); buffer.data.duplicate().get(bytes)
                        dataBytes.addAndGet(bytes.size.toLong())
                        val frame = wireJson.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                        check(frame.string("from") == "phone")
                        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, decodeBase64(frame.string("nonce"))))
                        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|phone|${frame.string("id")}".toByteArray())
                        received.offer(wireJson.parseToJsonElement(cipher.doFinal(decodeBase64(frame.string("ciphertext"))).toString(Charsets.UTF_8)).jsonObject)
                    } catch (_: Exception) { errors.offer("desktop packet rejected") }
                }
            })
            desktop!!.createOffer(sdpObserver(errors, created = { offer ->
                desktop!!.setLocalDescription(sdpObserver(errors, set = { if (desktop!!.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) publishOffer() }), offer)
            }), MediaConstraints())
            assertTrue("native channel did not open: ${errors.peek()}", opened.await(35, TimeUnit.SECONDS))
            val requestId = UUID.randomUUID().toString()
            val task = buildJsonObject { put("type", "request"); put("requestId", requestId); put("method", "status"); put("params", buildJsonObject { put("marker", MARKER) }); put("sentAt", System.currentTimeMillis()) }
            val packet = desktopPacket(pairing, task)
            assertTrue(channel!!.send(DataChannel.Buffer(ByteBuffer.wrap(packet.toByteArray()), false)))
            val result = received.poll(10, TimeUnit.SECONDS)
            assertNotNull("native response missing: ${errors.peek()}", result)
            assertEquals(requestId, result!!.string("requestId"))
            assertEquals(MARKER, result.getValue("result").jsonObject.string("marker"))
            assertTrue(errors.isEmpty())
            assertEquals(2, signaling.size)
            assertTrue(signaling.none { it.contains(MARKER) || it.contains("\"method\"") || it.contains("typ relay") })
            assertTrue(dataBytes.get() > 0)
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("nativeDirectEvidence", "host-candidate two-native-peers; signalingBytes=${signalBytes.get()}; directEncryptedBytes=${dataBytes.get()}; taskWebSocketBytes=0; TURN=disabled")
            })
        } finally {
            phone?.close(); channel?.unregisterObserver(); channel?.close(); channel?.dispose(); desktop?.dispose(); factory.dispose()
        }
    }
    private fun sdpObserver(errors: LinkedBlockingQueue<String>, created: (SessionDescription) -> Unit = {}, set: () -> Unit = {}) = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = created(description)
        override fun onSetSuccess() = set()
        override fun onCreateFailure(error: String) { errors.offer("create SDP failed") }
        override fun onSetFailure(error: String) { errors.offer("set SDP failed") }
    }
    private fun desktopPacket(pairing: Pairing, message: JsonObject): String {
        val id = UUID.randomUUID().toString(); val nonce = ByteArray(12) { (it + 1).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(decodeBase64(pairing.key), "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("lolicode-companion/1|${pairing.roomId}|desktop|$id".toByteArray())
        return buildJsonObject { put("type", "packet"); put("v", 1); put("from", "desktop"); put("id", id); put("nonce", encodeBase64(nonce)); put("ciphertext", encodeBase64(cipher.doFinal(message.toString().toByteArray()))) }.toString()
    }
    companion object { private const val MARKER = "LOLICODE_NATIVE_DIRECT_FIXTURE_20261026" }
}
