package art.treasuregrove.lolicode.mobile.data

import android.content.Context
import art.treasuregrove.lolicode.mobile.protocol.PacketCipher
import art.treasuregrove.lolicode.mobile.protocol.validateDirectSdp
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.webrtc.*

/** Native SCTP/DTLS answerer. It has no relay, media tracks or TURN fallback. */
class NativeDirectPeer(context: Context, private val events: DirectPeerEvents,
    private val stunUrls: List<String> = listOf("stun:lolicode.com:3478")) : DirectPeer {
    private val queue = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "lolicode-direct").apply { isDaemon = true } }
    private val closed = AtomicBoolean(false)
    private val opened = AtomicBoolean(false)
    private val failureQueued = AtomicBoolean(false)
    private val inboundQueuedBytes = AtomicLong(0)
    private val channelLock = Any()
    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null
    private var negotiationId: String? = null
    private var answerSent = false
    private var gatherTimeout: ScheduledFuture<*>? = null
    private val deadline: ScheduledFuture<*>
    init {
        require(stunUrls.all { it == "stun:lolicode.com:3478" }) { "不允许使用任务中转服务器" }
        initialize(context.applicationContext)
        deadline = queue.schedule({ fail() }, 40, TimeUnit.SECONDS)
    }
    override fun acceptOffer(negotiationId: String, sdp: String) = post {
        if (this.negotiationId != null) { fail(); return@post }
        try {
            validateDirectSdp(sdp)
            this.negotiationId = negotiationId
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
            val configuration = PeerConnection.RTCConfiguration(stunUrls.map { PeerConnection.IceServer.builder(it).createIceServer() }).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
                iceTransportsType = PeerConnection.IceTransportsType.ALL
            }
            val connection = factory!!.createPeerConnection(configuration, observer) ?: error("native peer unavailable")
            peer = connection
            connection.setAudioPlayout(false); connection.setAudioRecording(false)
            connection.setRemoteDescription(sdpObserver(set = {
                connection.createAnswer(sdpObserver(created = { answer ->
                    connection.setLocalDescription(sdpObserver(set = {
                        if (connection.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) publishAnswer()
                        else gatherTimeout = queue.schedule({ publishAnswer() }, 10, TimeUnit.SECONDS)
                    }), answer)
                }), MediaConstraints())
            }), SessionDescription(SessionDescription.Type.OFFER, sdp))
        } catch (_: Exception) { fail() }
    }

    override fun send(frame: String): Boolean {
        val bytes = frame.toByteArray(Charsets.UTF_8)
        if (closed.get() || failureQueued.get() || bytes.size > PacketCipher.MAX_FRAME) { reject(); return false }
        return synchronized(channelLock) {
            val current = channel
            if (current == null || current.state() != DataChannel.State.OPEN || current.bufferedAmount() > 512 * 1024 - bytes.size) {
                reject(); false
            } else runCatching { current.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false)) }.getOrDefault(false).also { if (!it) reject() }
        }
    }

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state in listOf(PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.DISCONNECTED, PeerConnection.IceConnectionState.CLOSED)) post { fail() }
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state in listOf(PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.DISCONNECTED, PeerConnection.PeerConnectionState.CLOSED)) post { fail() }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) post { publishAnswer() } }
        override fun onIceCandidate(candidate: IceCandidate) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) { post { fail() } }
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onDataChannel(incoming: DataChannel) = post {
            if (incoming.label() != CHANNEL_LABEL || channel != null) { incoming.close(); incoming.dispose(); fail(); return@post }
            // The SDK exposes no DCEP protocol getter. The desktop creates the
            // fixed protocol; label, DTLS and authenticated v1 status are checked.
            synchronized(channelLock) { channel = incoming }
            incoming.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) { if (incoming.bufferedAmount() > 512 * 1024) post { fail() } }
                override fun onStateChange() = post { channelState(incoming) }
                override fun onMessage(buffer: DataChannel.Buffer) {
                    if (closed.get() || failureQueued.get()) return
                    val size = buffer.data.remaining()
                    if (buffer.binary || size > PacketCipher.MAX_FRAME) { reject(); return }
                    if (inboundQueuedBytes.addAndGet(size.toLong()) > 512 * 1024) {
                        inboundQueuedBytes.addAndGet(-size.toLong()); reject(); return
                    }
                    val copied = ByteArray(size); buffer.data.duplicate().get(copied)
                    post {
                        try {
                            if (failureQueued.get()) return@post
                            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(copied)).toString()
                            events.frame(text)
                        } catch (_: Exception) { fail() }
                        finally { inboundQueuedBytes.addAndGet(-size.toLong()) }
                    }
                }
            })
            channelState(incoming)
        }
    }

    private fun channelState(current: DataChannel) {
        if (closed.get() || failureQueued.get()) return
        when (current.state()) {
            DataChannel.State.OPEN -> if (opened.compareAndSet(false, true)) { deadline.cancel(false); events.opened() }
            DataChannel.State.CLOSING, DataChannel.State.CLOSED -> fail()
            else -> Unit
        }
    }
    private fun publishAnswer() {
        if (closed.get() || failureQueued.get() || answerSent) return
        val answer = peer?.localDescription ?: return
        try {
            validateDirectSdp(answer.description)
            answerSent = true; gatherTimeout?.cancel(false)
            events.answer(negotiationId ?: error("missing negotiation"), answer.description)
        } catch (_: Exception) { fail() }
    }
    private fun sdpObserver(set: () -> Unit = {}, created: (SessionDescription) -> Unit = {}) = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = post { created(description) }
        override fun onSetSuccess() = post(set)
        override fun onCreateFailure(error: String) = post { fail() }
        override fun onSetFailure(error: String) = post { fail() }
    }
    private fun post(block: () -> Unit) { if (!closed.get()) runCatching { queue.execute { if (!closed.get()) block() } } }
    private fun reject() { if (failureQueued.compareAndSet(false, true)) post { fail() } }
    private fun fail() { if (!closed.get()) try { events.failed() } finally { close() } }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        deadline.cancel(false); gatherTimeout?.cancel(false)
        queue.execute {
            synchronized(channelLock) { channel?.let { it.unregisterObserver(); it.close(); it.dispose() }; channel = null }
            peer?.dispose(); peer = null; factory?.dispose(); factory = null
            queue.shutdown()
        }
    }
    companion object {
        const val CHANNEL_LABEL = "lolicode.tasks.v1"
        const val CHANNEL_PROTOCOL = "lolicode-companion/1"
        private var initialized = false
        @Synchronized fun initialize(context: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .setEnableInternalTracer(false).setInjectableLogger({ _, _, _ -> }, Logging.Severity.LS_NONE).createInitializationOptions())
            initialized = true
        }
    }
}
