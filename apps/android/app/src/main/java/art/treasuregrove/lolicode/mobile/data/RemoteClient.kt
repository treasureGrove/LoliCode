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

enum class ConnectionReasonCode { ROLE_CONNECTED, PEER_NOT_READY, AUTH_REJECTED, SERVICE_LIMIT, PROTOCOL_INVALID, NETWORK_IO, PEER_OFFLINE, DIRECT_UNAVAILABLE, AUTH_REFRESH_FAILED, SERVER_REJECTED, NORMAL_CLOSED, OTHER }

fun handshakeRetryDelay(reason: ConnectionReasonCode, attempt: Int): Long? =
    if (reason in setOf(ConnectionReasonCode.ROLE_CONNECTED, ConnectionReasonCode.PEER_NOT_READY) && attempt in 0..2) listOf(500L, 1000L, 2000L)[attempt] else null

sealed interface ConnectionEvent {
    data object Ready : ConnectionEvent
    data class TransportReady(val transport: String, val epoch: String) : ConnectionEvent
    data class WaitingForTransport(val reason: String) : ConnectionEvent
    data class Peer(val online: Boolean) : ConnectionEvent
    data class Plaintext(val message: JsonObject) : ConnectionEvent
    data class PushStatus(val configured: Boolean, val registered: Boolean) : ConnectionEvent
    data class Closed(val reason: String, val retryable: Boolean = true, val authenticationRejected: Boolean = false,
        val reasonCode: ConnectionReasonCode = ConnectionReasonCode.OTHER) : ConnectionEvent
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
    private val pendingActivity = ConcurrentHashMap<String, Long>()
    private val outgoingTransfers = ConcurrentHashMap<String, String>()
    private val logical = LogicalJson.Receiver()
    @Volatile private var logicalCapable = false
    private data class AuthRefresh(val requestId: String, val expiresAt: Long, val result: CompletableDeferred<Long>)
    private val authRefreshGate = Mutex()
    @Volatile private var authRefresh: AuthRefresh? = null
    private val ended = AtomicBoolean(false)
    private var socket: WebSocket? = null
    @Volatile private var ready = false
    private var pairingConfirmed = computer.approved
    private var direct: DirectPeer? = null
    private var negotiationId: String? = null
    @Volatile private var serverTextRelay = false
    @Volatile private var authRefreshSupported = false
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
    private val logicalExpiry = jobs.launch {
        while (isActive) {
            delay(1000)
            logical.expire()?.let { expired ->
                pending[expired.requestId]?.completeExceptionally(IOException("完整消息接收超时，请刷新确认；任务不会自动重试"))
                sendLogicalCancel(expired.transferId)
            }
        }
    }
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
                            authRefreshSupported = computer.accountId != null && frame.boolean("authRefresh")
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
                        "auth.renewed" -> {
                            val pending = authRefresh ?: error("未请求设备会话续期")
                            require(frame.keys == setOf("type", "v", "requestId", "expiresAt") && frame["v"] == JsonPrimitive(1))
                            require(frame.string("requestId") == pending.requestId && (frame["expiresAt"] as? JsonPrimitive)?.isString == false && frame.long("expiresAt") == pending.expiresAt)
                            require(pending.result.complete(pending.expiresAt))
                        }
                        "error" -> {
                            val code = frame.string("code")
                            val auth = code in setOf("unauthorized", "revoked", "device_revoked", "invalid_token", "expired_token", "authentication_required")
                            val temporary = code in setOf("role_connected", "peer_not_ready")
                            val reasonCode = when {
                                code == "role_connected" -> ConnectionReasonCode.ROLE_CONNECTED
                                code == "peer_not_ready" -> ConnectionReasonCode.PEER_NOT_READY
                                auth -> ConnectionReasonCode.AUTH_REJECTED
                                code in setOf("text_rate_limited", "text_monthly_quota_exhausted", "text_budget_unavailable", "text_slow_peer", "rate_limited", "monthly_limit", "capacity") -> ConnectionReasonCode.SERVICE_LIMIT
                                code in setOf("replayed_text", "text_epoch_invalid", "text_not_negotiated", "invalid_message", "invalid_frame") -> ConnectionReasonCode.PROTOCOL_INVALID
                                else -> ConnectionReasonCode.SERVER_REJECTED
                            }
                            end(when { auth -> "设备会话无效或已撤销，请重新登录"; temporary -> "上一条连接正在关闭，正在重新建立安全连接"; else -> "受限文本服务达到限额或暂时不可用，请稍后重连" }, retryable = temporary, authenticationRejected = auth, reasonCode = reasonCode)
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
                    end("连接数据未通过验证；请检查设备时间并重新连接", retryable = false, reasonCode = ConnectionReasonCode.PROTOCOL_INVALID)
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { end("协议不支持二进制帧") }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                val limited = reason.startsWith("text_") || reason == "replayed_text"
                val rejected = !limited && (code == 4003 || code == 4001 || (code == 1008 && reason in setOf("unauthorized", "revoked", "device_revoked", "invalid_token", "expired_token", "authentication_required")))
                val temporary = reason in setOf("role_connected", "peer_not_ready")
                val reasonCode = when { reason == "role_connected" -> ConnectionReasonCode.ROLE_CONNECTED; reason == "peer_not_ready" -> ConnectionReasonCode.PEER_NOT_READY; rejected -> ConnectionReasonCode.AUTH_REJECTED; limited -> ConnectionReasonCode.SERVICE_LIMIT; code == 1008 -> ConnectionReasonCode.PROTOCOL_INVALID; else -> ConnectionReasonCode.NORMAL_CLOSED }
                end(when { rejected -> "设备会话无效或已撤销，请重新连接或登录"; limited -> "受限文本通道已停止：服务限额或连接校验未通过，请稍后重连"; temporary -> "上一条连接正在关闭，正在重新建立安全连接"; else -> "连接已断开，正在等待重连" }, retryable = temporary || (!limited && !rejected && code != 1008), authenticationRejected = rejected, reasonCode = reasonCode)
            }
            override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
                end("暂时无法连接中转，检查网络后将自动重连", reasonCode = ConnectionReasonCode.NETWORK_IO)
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
        logicalCapable = false; logical.clear(); outgoingTransfers.clear(); pendingActivity.clear()
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
        if (message.string("type").startsWith("logical.")) require(logicalCapable) { "电脑尚未协商完整消息协议" }
        val outcome = logical.ingest(message)
        if (outcome.cancelled != null) {
            outcome.progress?.requestId?.let { pending[it]?.completeExceptionally(IOException("电脑已取消未完成的消息")) }
            outgoingTransfers[outcome.cancelled]?.let { pending[it]?.completeExceptionally(IOException("电脑已取消未完整接收的请求；任务不会自动重试")) }
            return
        }
        outcome.progress?.requestId?.let { if (pending.containsKey(it)) pendingActivity[it] = monotonic() }
        val complete = outcome.message ?: return
        if (activeTransport == "text") validateTextValue(complete)
        receiveNormal(complete)
    }

    private fun receiveNormal(message: JsonObject) {
        if (message.string("type") == "response") {
            val waiter = pending.remove(message.string("requestId")) ?: return
            if (message.boolean("ok")) waiter.complete(message["result"] ?: JsonNull)
            else {
                val error = message["error"] as? JsonObject
                waiter.completeExceptionally(IOException(error?.string("message")?.ifBlank { null } ?: "电脑拒绝该操作"))
            }
        } else {
            if (message.string("type") == "pair.approved" && message.string("deviceId") == computer.deviceId) {
                pairingConfirmed = true
                val maximum = message["logicalJsonMaxBytes"] as? JsonPrimitive
                val capable = maximum?.isString == false && maximum.intOrNull == LogicalJson.MAX_BYTES && message.string("logicalCodec") == LogicalJson.CODEC
                if (capable && !logicalCapable) {
                    logicalCapable = true
                    sendProtocolControl(buildJsonObject {
                        put("type", "client.hello"); put("logicalCodec", LogicalJson.CODEC); put("logicalJsonMaxBytes", LogicalJson.MAX_BYTES); put("sentAt", System.currentTimeMillis())
                    })
                }
            }
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
        val regulated = useText || logicalCapable
        val urgent = regulated && (method == "run.cancel" || (method == "permission.reply" && params.string("decision") == "reject"))
        val gate = if (urgent) controlRequests else normalRequests
        if (useText) {
            check(textConfirmed) { "电脑尚未确认文本通道授权" }
            validateTextRequest(method, params)
        }
        if (regulated) check(gate.tryLock()) { "文本通道繁忙，请稍后重试" }
        val requestId = UUID.randomUUID().toString()
        val result = CompletableDeferred<JsonElement>()
        pending[requestId] = result
        pendingActivity[requestId] = monotonic()
        if (regulated && method == "run.cancel") cancelUnsentMutations(params.string("sessionId"))
        if (regulated && method in setOf("message.send", "question.reply")) queuedMutations[requestId] = params.string("sessionId") to result
        try {
            val message = buildJsonObject {
                put("type", "request"); put("requestId", requestId); put("method", method)
                put("params", params); put("sentAt", System.currentTimeMillis())
            }
            return withTimeout(if (logicalCapable) LogicalJson.HARD_MS else 25_000) {
                if (useText) sendTextPaced(message, result, urgent) else sendDirectLogical(message, result, urgent)
                if (logicalCapable) awaitLogicalResponse(requestId, result) else result.await()
            }
        } finally {
            logical.cancelRequest(requestId)?.let(::sendLogicalCancel)
            outgoingTransfers.entries.filter { it.value == requestId }.forEach { entry -> outgoingTransfers.remove(entry.key); sendLogicalCancel(entry.key) }
            pending.remove(requestId); pendingActivity.remove(requestId); queuedMutations.remove(requestId)
            if (regulated) gate.unlock()
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun awaitLogicalResponse(requestId: String, result: CompletableDeferred<JsonElement>): JsonElement {
        while (true) {
            val remaining = LogicalJson.IDLE_MS - (monotonic() - (pendingActivity[requestId] ?: monotonic()))
            if (remaining <= 0) throw IOException("30 秒未收到消息进度，请刷新确认；任务不会自动重试")
            val response = select<JsonElement?> { result.onAwait { it }; onTimeout(remaining) { null } }
            if (response != null) return response
        }
    }

    fun close() { end("已暂停前台连接", notify = false) }
    fun failAuthRefresh(authenticationRejected: Boolean = false) {
        end("设备会话续期失败，请重新连接或登录", retryable = !authenticationRejected, authenticationRejected = authenticationRejected)
    }

    /** Replace only this socket's short-lived account ticket; keep its epoch, cipher and assemblies intact. */
    suspend fun requestAuthRefresh(deviceToken: String, expiresAt: Long): Long {
        require(computer.accountId != null && deviceToken.matches(Regex("^[A-Za-z0-9_-]{32,256}$")))
        require(expiresAt > System.currentTimeMillis() && expiresAt - System.currentTimeMillis() <= 930_000)
        check(authRefreshSupported) { "电脑设备服务尚未支持连接内续期，请升级后重新连接" }
        check(authRefreshGate.tryLock()) { "设备会话正在续期" }
        val refresh = AuthRefresh(UUID.randomUUID().toString(), expiresAt, CompletableDeferred())
        try {
            synchronized(this) {
                check(!ended.get() && socket != null) { "设备连接已关闭" }
                authRefresh = refresh
                check(socket?.send(buildJsonObject {
                    put("type", "auth.refresh"); put("v", 1); put("requestId", refresh.requestId); put("deviceToken", deviceToken)
                }.toString()) == true)
            }
            return withTimeout(15_000) { refresh.result.await() }
        } catch (failure: Exception) {
            end("设备会话续期未确认，请重新连接", retryable = true)
            throw IOException("设备会话续期未确认，请重新连接")
        } finally { if (authRefresh === refresh) authRefresh = null; authRefreshGate.unlock() }
    }

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

    private fun encodeLogical(message: JsonObject): LogicalJson.Encoded {
        if (activeTransport == "text") validateTextValue(message)
        val encoded = LogicalJson.encode(message)
        require(encoded.transferId == null || logicalCapable) { "电脑尚未支持 1 MiB 完整消息，请升级电脑端" }
        return encoded
    }

    private suspend fun sendTextPaced(message: JsonObject, abort: CompletableDeferred<JsonElement>? = null, urgent: Boolean = false) {
        val current = textCipher ?: throw IOException("文本通道已失效")
        val encoded = encodeLogical(message)
        val requestId = message.string("requestId")
        encoded.transferId?.let { outgoingTransfers[it] = requestId }
        var complete = false
        try {
            suspend fun sendParts(rate: Int) {
                for ((index, part) in encoded.frames.withIndex()) {
                    check(abort?.isCompleted != true && textCipher === current && ready && !ended.get()) { "尚未发送的消息已取消或通道已变化" }
                    val fresh = if (encoded.transferId != null) JsonObject(part + ("sentAt" to JsonPrimitive(System.currentTimeMillis()))) else part
                    val frame = current.seal(fresh)
                    val bytes = frame.toByteArray(Charsets.UTF_8).size + 15
                    if (urgent) {
                        require(bytes <= 1024) { "停止或拒绝请求超过文本控制上限，请直连确认" }
                        paceDelay((1000 - (monotonic() - lastControlAt)).coerceAtLeast(0), abort)
                    } else paceDelay((bytes.toLong() * 1000 + rate - 1) / rate, abort)
                    writeTextFrame(frame, current, abort, requestId, index == encoded.frames.lastIndex)
                    if (requestId.isNotBlank()) pendingActivity[requestId] = monotonic()
                    if (urgent) lastControlAt = monotonic()
                }
            }
            if (urgent) sendParts(500)
            else textWrites.withLock { sendParts(if (encoded.transferId != null) 1500 else 500) }
            complete = true
        } finally {
            encoded.transferId?.let { id -> outgoingTransfers.remove(id); if (!complete && textCipher === current) sendLogicalCancel(id) }
        }
    }

    private suspend fun sendDirectLogical(message: JsonObject, abort: CompletableDeferred<JsonElement>, urgent: Boolean) {
        val generation = directGeneration
        val encoded = encodeLogical(message)
        val requestId = message.string("requestId")
        encoded.transferId?.let { outgoingTransfers[it] = requestId }
        var complete = false
        try {
            for ((index, part) in encoded.frames.withIndex()) {
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                val queueWaitStarted = monotonic()
                while (!urgent && computer.accountId != null && (direct?.bufferedBytes() ?: Long.MAX_VALUE) > 16 * 1024) {
                    check(!abort.isCompleted && !ended.get() && ready && directGeneration == generation) { "尚未发送的消息已取消或通道已变化" }
                    check(monotonic() - queueWaitStarted < LogicalJson.IDLE_MS) { "直连发送队列 30 秒没有进度，请刷新确认" }
                    delay(20)
                }
                val fresh = if (encoded.transferId != null) JsonObject(part + ("sentAt" to JsonPrimitive(System.currentTimeMillis()))) else part
                writeDirectFrame(fresh, abort, requestId, generation, index == encoded.frames.lastIndex)
                pendingActivity[requestId] = monotonic()
                // Yield between chunks so a stop/control coroutine can cancel an unfinished upload.
                if (encoded.transferId != null) delay(20)
            }
            complete = true
        } finally {
            encoded.transferId?.let { id -> outgoingTransfers.remove(id); if (!complete && directGeneration == generation) sendLogicalCancel(id) }
        }
    }

    @Synchronized private fun writeDirectFrame(message: JsonObject, abort: CompletableDeferred<JsonElement>, requestId: String, generation: Int, complete: Boolean) {
        check(!ended.get() && ready && directGeneration == generation && activeTransport != "text" && !abort.isCompleted) { "尚未发送的消息已取消或通道已变化" }
        sendEncrypted(message)
        if (complete) queuedMutations.remove(requestId)
    }

    @Synchronized private fun sendProtocolControl(message: JsonObject) {
        check(!ended.get() && ready)
        if (activeTransport == "text") {
            check(textConfirmed)
            val frame = (textCipher ?: error("文本通道已失效")).seal(message)
            check((socket?.queueSize() ?: Long.MAX_VALUE) <= 16 * 1024 - frame.toByteArray(Charsets.UTF_8).size)
            check(socket?.send(frame) == true)
        } else sendEncrypted(message)
    }

    private fun sendLogicalCancel(transferId: String) {
        if (!logicalCapable || !ready || ended.get()) return
        runCatching { sendProtocolControl(JsonObject(LogicalJson.cancel(transferId) + ("sentAt" to JsonPrimitive(System.currentTimeMillis())))) }
    }

    @Synchronized private fun cancelUnsentMutations(session: String) {
        queuedMutations.entries.filter { it.value.first == session }.forEach { (id, value) ->
            value.second.completeExceptionally(IOException("尚未发送的任务已取消")); queuedMutations.remove(id)
        }
    }

    @Synchronized private fun writeTextFrame(frame: String, epochCipher: TextCipher, abort: CompletableDeferred<JsonElement>?, requestId: String, complete: Boolean = true) {
        check(!ended.get() && ready && textConfirmed && activeTransport == "text" && textCipher === epochCipher) { "文本通道已变化，请重新确认任务状态" }
        check(abort?.isCompleted != true) { "尚未发送的请求已取消" }
        check((socket?.queueSize() ?: Long.MAX_VALUE) <= 16 * 1024 - frame.toByteArray(Charsets.UTF_8).size) { "文本通道繁忙，请稍后重试" }
        check(socket?.send(frame) == true) { "文本通道发送失败，请刷新任务状态" }
        if (complete) queuedMutations.remove(requestId)
    }

    @Synchronized private fun end(reason: String, notify: Boolean = true, retryable: Boolean = true, authenticationRejected: Boolean = false, reasonCode: ConnectionReasonCode = ConnectionReasonCode.OTHER) {
        if (!ended.compareAndSet(false, true)) return
        ready = false
        directGeneration++; directDeadline?.cancel(false); directDeadline = null
        activeTransport = null; textCipher = null; textConfirmed = false
        authRefreshSupported = false
        logicalCapable = false; logical.clear(); outgoingTransfers.clear(); pendingActivity.clear()
        authRefresh?.result?.completeExceptionally(IOException("设备连接已关闭")); authRefresh = null
        acknowledgementQueue.close(); jobs.cancel()
        queuedMutations.clear()
        socket?.close(1000, null)
        direct?.close(); direct = null
        pending.values.forEach { it.completeExceptionally(IOException("连接中断，请刷新任务状态；发送过的任务不会自动重试")) }
        pending.clear()
        if (notify) onEvent(ConnectionEvent.Closed(reason, retryable, authenticationRejected, reasonCode))
    }

    private fun monotonic() = System.nanoTime() / 1_000_000

    companion object {
        private val deadlines = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "companion-direct-deadline").apply { isDaemon = true } }
        private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
}
