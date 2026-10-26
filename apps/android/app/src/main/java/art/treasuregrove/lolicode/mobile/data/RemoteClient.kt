package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString

sealed interface ConnectionEvent {
    data object Ready : ConnectionEvent
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
    private val onEvent: (ConnectionEvent) -> Unit,
) {
    constructor(computer: PairedComputer, deviceName: String, onEvent: (ConnectionEvent) -> Unit) : this(computer, deviceName, null, null, onEvent)
    constructor(computer: PairedComputer, deviceName: String, deviceToken: String?, onEvent: (ConnectionEvent) -> Unit) : this(computer, deviceName, deviceToken, null, onEvent)
    private val cipher = PacketCipher(computer.pairing)
    private val signalCipher = DirectSignalCipher(computer.pairing)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonElement>>()
    private val ended = AtomicBoolean(false)
    private var socket: WebSocket? = null
    @Volatile private var ready = false
    private var pairingConfirmed = computer.approved
    private var direct: DirectPeer? = null
    private var negotiationId: String? = null

    fun connect() {
        require(computer.accountId == null || !deviceToken.isNullOrBlank()) { "账号设备会话尚未就绪" }
        socket = http.newWebSocket(Request.Builder().url(computer.pairing.relayUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (ended.get()) { webSocket.close(1000, null); return }
                webSocket.send(buildJsonObject {
                    put("type", "hello"); put("v", 1); put("role", "phone")
                    put("roomId", computer.id); put("token", computer.pairing.phoneToken)
                    if (computer.accountId != null) put("deviceToken", deviceToken)
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
                            if (computer.accountId != null) return
                            ready = true
                            // A saved pending phone can miss an approval while
                            // stopped. Re-confirm even after QR enrollment expiry.
                            if (!pairingConfirmed) requestPairing(deviceName)
                            onEvent(ConnectionEvent.Ready)
                        }
                        "peer" -> {
                            val online = frame.boolean("online")
                            if (computer.accountId != null) {
                                if (online) ensureDirect()
                                else if (direct != null) { end("直连已断开，电脑在线状态以设备列表为准"); return }
                                if (ended.get()) return
                            }
                            if (online && ready && !pairingConfirmed) requestPairing(deviceName)
                            onEvent(ConnectionEvent.Peer(online))
                        }
                        "push.status" -> onEvent(ConnectionEvent.PushStatus(frame.boolean("configured"), frame.boolean("registered")))
                        "error" -> end("设备协调服务拒绝连接，请重新连接或登录", authenticationRejected = true)
                        "signal" -> {
                            require(computer.accountId != null) { "旧版连接不接受直连信令" }
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
                    }
                } catch (_: Exception) {
                    // Never include received data or cryptographic material in logs or errors.
                    end("连接数据未通过验证；请检查设备时间并重新连接", retryable = false)
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { end("协议不支持二进制帧") }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                val rejected = code == 4003 || code == 4001 || code == 1008
                end(if (rejected) "设备会话无效或已撤销，请重新连接或登录" else "连接已断开，正在等待重连", authenticationRejected = rejected)
            }
            override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
                end("暂时无法连接中转，检查网络后将自动重连")
            }
        })
    }

    @Synchronized private fun ensureDirect(): DirectPeer? {
        if (ended.get()) return null
        direct?.let { return it }
        val factory = directFactory ?: run { end("此设备无法加载原生直连组件", retryable = false); return null }
        return try { factory.create(object : DirectPeerEvents {
            override fun answer(negotiationId: String, sdp: String) {
                if (ended.get() || negotiationId != this@RemoteClient.negotiationId) return
                try {
                    check(socket?.send(signalCipher.seal(buildJsonObject {
                        put("type", "direct.answer"); put("negotiationId", negotiationId); put("sdp", sdp); put("sentAt", System.currentTimeMillis())
                    })) == true)
                } catch (_: Exception) { end("直连不可用，请切换网络后重试", retryable = false) }
            }
            override fun opened() {
                if (ended.get()) return
                if (negotiationId == null) { end("直连协商身份不匹配", retryable = false); return }
                ready = true; onEvent(ConnectionEvent.Ready)
            }
            override fun frame(frame: String) {
                if (ended.get()) return
                try {
                    require(ready)
                    require(frame.toByteArray().size <= PacketCipher.MAX_FRAME)
                    receive(cipher.open(wireJson.parseToJsonElement(frame).jsonObject))
                } catch (_: Exception) { end("直连数据未通过验证，连接已关闭", retryable = false) }
            }
            override fun failed() { end("直连不可用，请切换网络后重试", retryable = false) }
        }).also { direct = it } }
        catch (_: LinkageError) { end("此设备无法加载原生直连组件", retryable = false); null }
        catch (_: Exception) { end("直连不可用，请切换网络后重试", retryable = false); null }
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
        val requestId = UUID.randomUUID().toString()
        val result = CompletableDeferred<JsonElement>()
        pending[requestId] = result
        try {
            sendEncrypted(buildJsonObject {
                put("type", "request"); put("requestId", requestId); put("method", method)
                put("params", params); put("sentAt", System.currentTimeMillis())
            })
            return withTimeout(25_000) { result.await() }
        } finally { pending.remove(requestId) }
    }

    fun close() { end("已暂停前台连接", notify = false) }

    private fun sendEncrypted(message: JsonObject) {
        check(ready && !ended.get()) { "连接尚未就绪" }
        if (computer.accountId != null) {
            val frame = wireJson.parseToJsonElement(cipher.seal(message)).jsonObject
            check(direct?.send(JsonObject(frame + ("from" to text("phone"))).toString()) == true) { "直连发送失败，请重新连接后检查当前任务状态" }
        } else check(socket?.send(cipher.seal(message)) == true) { "发送失败，请重新连接后检查当前任务状态" }
    }

    @Synchronized private fun end(reason: String, notify: Boolean = true, retryable: Boolean = true, authenticationRejected: Boolean = false) {
        if (!ended.compareAndSet(false, true)) return
        ready = false
        socket?.close(1000, null)
        direct?.close(); direct = null
        pending.values.forEach { it.completeExceptionally(IOException("连接中断，请刷新任务状态；发送过的任务不会自动重试")) }
        pending.clear()
        if (notify) onEvent(ConnectionEvent.Closed(reason, retryable, authenticationRejected))
    }

    companion object {
        private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
}
