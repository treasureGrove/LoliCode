package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString

sealed interface ConnectionEvent {
    data object Ready : ConnectionEvent
    data class TransportReady(val transport: String, val epoch: String) : ConnectionEvent
    data class WaitingForTransport(val reason: String) : ConnectionEvent
    data class Peer(val online: Boolean) : ConnectionEvent
    data class Plaintext(val message: JsonObject) : ConnectionEvent
    data class PushStatus(val configured: Boolean, val registered: Boolean) : ConnectionEvent
    data class Closed(val reason: String, val retryable: Boolean = true, val authenticationRejected: Boolean = false) : ConnectionEvent
}

class RemoteClient(
    private val computer: PairedComputer,
    private val deviceName: String = "Android",
    private val deviceToken: String? = null,
    private val directFactory: DirectPeerFactory? = null,
    private val directTimeoutMs: Long = 40_000,
    private val onEvent: (ConnectionEvent) -> Unit,
) {
    constructor(computer: PairedComputer, deviceName: String, onEvent: (ConnectionEvent) -> Unit) : this(computer, deviceName, null, null, onEvent = onEvent)
    constructor(computer: PairedComputer, deviceName: String, deviceToken: String?, onEvent: (ConnectionEvent) -> Unit) : this(computer, deviceName, deviceToken, null, onEvent = onEvent)
    private val cipher = PacketCipher(computer.pairing)
    private val signalCipher = DirectSignalCipher(computer.pairing)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonElement>>()
    private val ended = AtomicBoolean(false)
    private var socket: WebSocket? = null
    @Volatile private var ready = false
    private var pairingConfirmed = computer.approved
    private var direct: DirectPeer? = null
    private var negotiationId: String? = null
    @Volatile private var serverTextRelay = false
    @Volatile private var peerOnline = false
    @Volatile private var activeTransport: String? = null
    @Volatile private var textCipher: TextCipher? = null
    @Volatile private var textConfirmed = false
    @Volatile private var directGeneration = 0
    private var directDeadline: ScheduledFuture<*>? = null
    private val normalRequests = Mutex()
    private val controlRequests = Mutex()
    private val textWrites = Mutex()
    private var lastControlAt = 0L
    private val acknowledgementQueue = Channel<String>(16)
    private val jobs = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queuedMutations = ConcurrentHashMap<String, Pair<String, CompletableDeferred<JsonElement>>>()
    private var acknowledgementWorker = startAcknowledgements()
    private fun startAcknowledgements() = jobs.launch {
            for (id in acknowledgementQueue) {
                runCatching {
                    val message = buildJsonObject { put("type", "event.ack"); put("eventId", id); put("sentAt", System.currentTimeMillis()) }
                    if (activeTransport == "text" && textConfirmed) sendTextPaced(message) else if (ready) sendEncrypted(message)
                }
            }
    }

    fun connect() {
        require(computer.accountId == null || !deviceToken.isNullOrBlank()) { "账号设备会话尚未就绪" }
        socket = http.newWebSocket(Request.Builder().url(computer.pairing.relayUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (ended.get()) { webSocket.close(1000, null); return }
                webSocket.send(buildJsonObject {
                    put("type", "hello"); put("v", 1); put("role", "phone")
                    put("roomId", computer.id); put("token", computer.pairing.phoneToken)
                    if (computer.accountId != null) {
                        put("deviceToken", deviceToken)
                        put("capabilities", buildJsonArray { add("text-v1") })
                    }
                }.toString())
            }

            override fun onMessage(webSocket: WebSocket, value: String) {
                if (ended.get()) return
                try {
                    require(value.toByteArray(Charsets.UTF_8).size <= PacketCipher.MAX_FRAME) { "消息超过协议大小限制" }
                    val frame = wireJson.parseToJsonElement(value).jsonObject
                    when (frame.string("type")) {
                        "ready" -> {
                            require(frame.long("v") == 1L)
                            serverTextRelay = frame.boolean("textRelay")
                            if (computer.accountId != null) return
                            ready = true
                            // A saved pending phone can miss an approval while
                            // stopped. Re-confirm even after QR enrollment expiry.
                            if (!pairingConfirmed) requestPairing(deviceName)
                            onEvent(ConnectionEvent.Ready)
                        }
                        "peer" -> {
                            val online = frame.boolean("online")
                            peerOnline = online
                            if (computer.accountId != null) {
                                if (online && frame.boolean("textRelay")) {
                                    require(serverTextRelay && TextCipher.validEpoch(frame.string("textEpoch")))
                                    val epoch = frame.string("textEpoch")
                                    if (textCipher?.epoch != epoch) {
                                        resetTransport("正在验证受限文本通道")
                                        textCipher = TextCipher(computer.pairing, epoch)
                                    }
                                } else if (online) {
                                    if (activeTransport != "text") ensureDirect()
                                } else if (direct != null || activeTransport != null || textCipher != null) {
                                    if (serverTextRelay) resetTransport("连接切换中，等待电脑重新验证文本通道")
                                    else { end("直连已断开，电脑在线状态以设备列表为准"); return }
                                }
                                if (ended.get()) return
                            }
                            if (computer.accountId == null && online && ready && !pairingConfirmed) requestPairing(deviceName)
                            onEvent(ConnectionEvent.Peer(online))
                        }
                        "push.status" -> onEvent(ConnectionEvent.PushStatus(frame.boolean("configured"), frame.boolean("registered")))
                        "error" -> {
                            val code = frame.string("code")
                            val auth = code in setOf("unauthorized", "revoked", "device_revoked", "invalid_token", "expired_token", "authentication_required")
                            end(if (auth) "设备会话无效或已撤销，请重新登录" else "受限文本服务达到限额或暂时不可用，请稍后重连", retryable = false, authenticationRejected = auth)
                        }
                        "signal" -> {
                            require(computer.accountId != null) { "旧版连接不接受直连信令" }
                            require(peerOnline && textCipher == null && activeTransport != "text")
                            val message = signalCipher.open(frame)
                            require(negotiationId == null) { "此连接已处理过直连协商" }
                            negotiationId = message.string("negotiationId")
                            ensureDirect()?.acceptOffer(message.string("negotiationId"), message.string("sdp"))
                        }
                        "packet" -> {
                            require(computer.accountId == null) { "账号连接禁止通过服务器收发任务" }
                            val message = cipher.open(frame)
                            receive(message)
                        }
                        "text" -> {
                            require(computer.accountId != null && peerOnline && serverTextRelay)
                            val text = textCipher ?: error("文本通道尚未协商")
                            receiveText(text.open(frame))
                        }
                    }
                } catch (_: Exception) {
                    // Never include received data or cryptographic material in logs or errors.
                    end("连接数据未通过验证；请检查设备时间并重新连接", retryable = false)
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { end("协议不支持二进制帧") }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                val limited = reason.startsWith("text_") || reason == "replayed_text"
                val rejected = !limited && (code == 4003 || code == 4001 || (code == 1008 && reason in setOf("unauthorized", "revoked", "device_revoked", "invalid_token", "expired_token", "authentication_required")))
                end(when { rejected -> "设备会话无效或已撤销，请重新连接或登录"; limited -> "受限文本通道已停止：服务限额或连接校验未通过，请稍后重连"; else -> "连接已断开，正在等待重连" }, retryable = !limited, authenticationRejected = rejected)
            }
            override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
                end("暂时无法连接中转，检查网络后将自动重连")
            }
        })
    }

    @Synchronized private fun ensureDirect(): DirectPeer? {
        if (ended.get()) return null
        direct?.let { return it }
        val factory = directFactory ?: run { nativeFailed("此设备无法加载原生直连组件"); return null }
        val currentGeneration = directGeneration
        directDeadline?.cancel(false)
        directDeadline = deadlines.schedule({ if (!ended.get() && currentGeneration == directGeneration && !ready) nativeFailed("直连超时，正在等待受限文本通道") }, directTimeoutMs, TimeUnit.MILLISECONDS)
        return try { factory.create(object : DirectPeerEvents {
            override fun answer(negotiationId: String, sdp: String) {
                if (ended.get() || currentGeneration != directGeneration || negotiationId != this@RemoteClient.negotiationId) return
                try {
                    check(socket?.send(signalCipher.seal(buildJsonObject {
                        put("type", "direct.answer"); put("negotiationId", negotiationId); put("sdp", sdp); put("sentAt", System.currentTimeMillis())
                    })) == true)
                } catch (_: Exception) { end("直连不可用，请切换网络后重试", retryable = false) }
            }
            override fun opened() {
                if (ended.get() || currentGeneration != directGeneration) return
                if (negotiationId == null) { end("直连协商身份不匹配", retryable = false); return }
                directDeadline?.cancel(false)
                activeTransport = "direct"; ready = true; onEvent(ConnectionEvent.Ready)
            }
            override fun frame(frame: String) {
                if (ended.get() || currentGeneration != directGeneration || activeTransport != "direct") return
                try {
                    require(ready)
                    require(frame.toByteArray().size <= PacketCipher.MAX_FRAME)
                    receive(cipher.open(wireJson.parseToJsonElement(frame).jsonObject))
                } catch (_: Exception) { end("直连数据未通过验证，连接已关闭", retryable = false) }
            }
            override fun failed() { if (currentGeneration == directGeneration) nativeFailed("直连不可用，正在等待受限文本通道") }
        }).let { peer -> if (currentGeneration == directGeneration && !ended.get()) peer.also { direct = it } else { peer.close(); null } } }
        catch (_: LinkageError) { nativeFailed("此设备无法加载原生直连组件"); null }
        catch (_: Exception) { nativeFailed("直连不可用，正在等待受限文本通道"); null }
    }

    @Synchronized private fun nativeFailed(reason: String) {
        if (ended.get()) return
        if (serverTextRelay) resetTransport(reason)
        else end("直连不可用，请切换网络后重试", retryable = false)
    }

    @Synchronized private fun resetTransport(reason: String) {
        ready = false; activeTransport = null; textConfirmed = false
        directGeneration++; directDeadline?.cancel(false); directDeadline = null
        val old = direct; direct = null; old?.close()
        negotiationId = null; textCipher = null
        while (acknowledgementQueue.tryReceive().isSuccess) { /* Discard the old epoch's unsent ACKs. */ }
        acknowledgementWorker.cancel(); acknowledgementWorker = startAcknowledgements()
        pending.values.forEach { it.completeExceptionally(IOException("通道已变化；任务不会自动重试，请刷新确认状态")) }; pending.clear()
        queuedMutations.clear()
        onEvent(ConnectionEvent.WaitingForTransport(reason))
    }

    @Synchronized private fun receiveText(message: JsonObject) {
        if (message.string("type") == "text.ready") {
            require(activeTransport == null && !ready)
            val challenge = message.string("challenge")
            require(challenge.matches(Regex("^[0-9a-f]{32}$")))
            val text = textCipher ?: error("缺少文本通道身份")
            val response = text.seal(buildJsonObject { put("type", "text.ready"); put("challenge", challenge); put("sentAt", System.currentTimeMillis()) })
            check(socket?.send(response) == true)
            directDeadline?.cancel(false)
            activeTransport = "text"; ready = true; textConfirmed = false
            onEvent(ConnectionEvent.TransportReady("text", text.epoch))
            return
        }
        require(ready && activeTransport == "text")
        if (message.string("type") == "pair.approved") {
            require(message.string("deviceId") == computer.deviceId)
            textConfirmed = true
        } else require(textConfirmed) { "电脑尚未确认文本通道授权" }
        receive(message)
    }

    private fun receive(message: JsonObject) {
        if (message.string("type") == "response") {
            val waiter = pending.remove(message.string("requestId")) ?: return
            if (message.boolean("ok")) waiter.complete(message["result"] ?: JsonNull)
            else {
                val error = message["error"] as? JsonObject
                waiter.completeExceptionally(IOException(error?.string("message")?.ifBlank { null } ?: "电脑拒绝该操作"))
            }
        } else {
            if (message.string("type") == "pair.approved" && message.string("deviceId") == computer.deviceId) pairingConfirmed = true
            onEvent(ConnectionEvent.Plaintext(message))
        }
    }

    private fun requestPairing(deviceName: String) = sendEncrypted(buildJsonObject {
        put("type", "pair.request"); put("deviceId", computer.deviceId)
        put("deviceName", deviceName.take(120)); put("sentAt", System.currentTimeMillis())
    })

    fun registerPush(token: String) {
        if (computer.accountId != null) return
        if (token.isBlank() || token.length > 4096 || !ready || ended.get()) return
        socket?.send(buildJsonObject { put("type", "push.register"); put("provider", "fcm"); put("token", token) }.toString())
    }

    suspend fun request(method: String, params: JsonObject = buildJsonObject { }): JsonElement {
        check(ready && !ended.get()) { "连接尚未就绪" }
        val useText = activeTransport == "text"
        val urgent = useText && (method == "run.cancel" || (method == "permission.reply" && params.string("decision") == "reject"))
        val gate = if (urgent) controlRequests else normalRequests
        if (useText) {
            check(textConfirmed) { "电脑尚未确认文本通道授权" }
            validateTextRequest(method, params)
            check(gate.tryLock()) { "文本通道繁忙，请稍后重试" }
        }
        val requestId = UUID.randomUUID().toString()
        val result = CompletableDeferred<JsonElement>()
        pending[requestId] = result
        if (useText && method == "run.cancel") cancelUnsentMutations(params.string("sessionId"))
        if (useText && method in setOf("message.send", "question.reply")) queuedMutations[requestId] = params.string("sessionId") to result
        try {
            val message = buildJsonObject {
                put("type", "request"); put("requestId", requestId); put("method", method)
                put("params", params); put("sentAt", System.currentTimeMillis())
            }
            return withTimeout(25_000) {
                if (useText) sendTextPaced(message, result, urgent) else sendEncrypted(message)
                result.await()
            }
        } finally { pending.remove(requestId); queuedMutations.remove(requestId); if (useText) gate.unlock() }
    }

    fun close() { end("已暂停前台连接", notify = false) }

    @Synchronized private fun sendEncrypted(message: JsonObject) {
        check(ready && !ended.get()) { "连接尚未就绪" }
        if (activeTransport == "text") {
            error("文本通道必须通过有界发送队列")
        } else if (computer.accountId != null) {
            val frame = wireJson.parseToJsonElement(cipher.seal(message)).jsonObject
            check(direct?.send(JsonObject(frame + ("from" to text("phone"))).toString()) == true) { "直连发送失败，请重新连接后检查当前任务状态" }
        } else check(socket?.send(cipher.seal(message)) == true) { "发送失败，请重新连接后检查当前任务状态" }
    }

    fun acknowledgeEvent(eventId: String) {
        if (eventId.length !in 1..128 || !ready || ended.get()) return
        if (activeTransport == "text" && !textConfirmed) return
        acknowledgementQueue.trySend(eventId)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun paceDelay(milliseconds: Long, abort: CompletableDeferred<JsonElement>?) {
        if (milliseconds <= 0) return
        if (abort == null) delay(milliseconds)
        else select<Unit> { onTimeout(milliseconds) { }; abort.onAwait { throw IOException("通道已变化，未发送的请求已取消") } }
    }

    private suspend fun sendTextPaced(message: JsonObject, abort: CompletableDeferred<JsonElement>? = null, urgent: Boolean = false) {
        val current = textCipher ?: throw IOException("文本通道已失效")
        val frame = current.seal(message)
        // The relay appends ,"from":"phone" before forwarding/accounting.
        val bytes = frame.toByteArray(Charsets.UTF_8).size + 15
        if (urgent) {
            require(bytes <= 1024) { "停止或拒绝请求超过文本控制上限，请直连确认" }
            val now = System.nanoTime() / 1_000_000
            paceDelay((1000 - (now - lastControlAt)).coerceAtLeast(0), abort)
            writeTextFrame(frame, current, abort, message.string("requestId"))
            lastControlAt = System.nanoTime() / 1_000_000
        } else textWrites.withLock {
            // Charge before each frame: no accumulated idle burst, including ACKs.
            paceDelay((bytes.toLong() * 1000 + 499) / 500, abort)
            writeTextFrame(frame, current, abort, message.string("requestId"))
        }
    }

    @Synchronized private fun cancelUnsentMutations(session: String) {
        queuedMutations.entries.filter { it.value.first == session }.forEach { (id, value) ->
            value.second.completeExceptionally(IOException("尚未发送的任务已取消")); queuedMutations.remove(id)
        }
    }

    @Synchronized private fun writeTextFrame(frame: String, epochCipher: TextCipher, abort: CompletableDeferred<JsonElement>?, requestId: String) {
        check(!ended.get() && ready && textConfirmed && activeTransport == "text" && textCipher === epochCipher) { "文本通道已变化，请重新确认任务状态" }
        check(abort?.isCompleted != true) { "尚未发送的请求已取消" }
        check((socket?.queueSize() ?: Long.MAX_VALUE) <= 16 * 1024 - frame.toByteArray(Charsets.UTF_8).size) { "文本通道繁忙，请稍后重试" }
        check(socket?.send(frame) == true) { "文本通道发送失败，请刷新任务状态" }
        queuedMutations.remove(requestId)
    }

    @Synchronized private fun end(reason: String, notify: Boolean = true, retryable: Boolean = true, authenticationRejected: Boolean = false) {
        if (!ended.compareAndSet(false, true)) return
        ready = false
        directGeneration++; directDeadline?.cancel(false); directDeadline = null
        activeTransport = null; textCipher = null; textConfirmed = false
        acknowledgementQueue.close(); jobs.cancel()
        queuedMutations.clear()
        socket?.close(1000, null)
        direct?.close(); direct = null
        pending.values.forEach { it.completeExceptionally(IOException("连接中断，请刷新任务状态；发送过的任务不会自动重试")) }
        pending.clear()
        if (notify) onEvent(ConnectionEvent.Closed(reason, retryable, authenticationRejected))
    }

    companion object {
        private val deadlines = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "companion-direct-deadline").apply { isDaemon = true } }
        private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
}
