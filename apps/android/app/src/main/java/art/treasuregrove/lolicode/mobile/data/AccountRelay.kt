package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Short-lived companion capability, never a forum token or a packet key. */
class DeviceSession(val accountId: String, val deviceToken: String, val expiresAt: Long, val device: AccountDevice) {
    fun needsRenewal(now: Long = System.currentTimeMillis()) = expiresAt - now <= 60_000
    override fun toString() = "DeviceSession(accountId=$accountId, deviceToken=[redacted], expiresAt=$expiresAt)"
}

class AccountRelay(private val base: HttpUrl = "https://lolicode.com/companion/v2/".toHttpUrl(),
    val webSocketUrl: String = "wss://lolicode.com/companion/ws", private val allowLocal: Boolean = false) {
    private val client = accountHttpClient()
    init {
        require(base.isHttps || (allowLocal && base.host in listOf("localhost", "127.0.0.1", "::1"))) { "设备服务必须使用 HTTPS" }
        require(base.username.isEmpty() && base.password.isEmpty() && base.query == null && base.fragment == null && base.encodedPath.endsWith('/')) { "设备服务地址无效" }
    }
    fun session(credential: ForumCredential, deviceId: String, deviceName: String, identity: DeviceIdentity, now: Long = System.currentTimeMillis()): DeviceSession {
        require(validDeviceId(deviceId)) { "设备标识无效" }
        val value = call("session", credential.bearer, buildJsonObject {
            put("deviceId", deviceId); put("deviceName", deviceName.take(120)); put("kind", "phone"); put("publicKey", identity.publicKeySpki)
        })
        val token = value.string("deviceToken"); val expiry = value.long("expiresAt")
        val device = AccountDevice.parse(value["device"] as? JsonObject ?: error("账号设备资料无效"))
        require(value.long("v") == 2L && value.string("accountId") == credential.account.id &&
            token.matches(Regex("^[A-Za-z0-9_-]{32,256}$")) && expiry > now && expiry - now <= 930_000 &&
            device.deviceId == deviceId && device.kind == "phone" && device.publicKey == identity.publicKeySpki && device.fingerprint == identity.fingerprint) { "账号设备会话身份无效" }
        return DeviceSession(credential.account.id, token, expiry, device)
    }
    fun devices(session: DeviceSession): List<AccountDevice> {
        val values = call("devices", session.deviceToken).array("devices")
        require(values.size <= 128) { "账号设备数量超过限制" }
        val devices = values.map { AccountDevice.parse(it as? JsonObject ?: error("账号设备资料无效")) }
        require(devices.map { it.deviceId }.distinct().size == devices.size) { "账号设备资料重复" }
        return devices.filter { it.kind == "desktop" }
    }
    fun presence(session: DeviceSession) { call("presence", session.deviceToken, buildJsonObject { }) }
    fun request(session: DeviceSession, desktopDeviceId: String): EnrollmentRequest {
        require(validDeviceId(desktopDeviceId)) { "电脑标识无效" }
        return EnrollmentRequest.parse(call("requests", session.deviceToken, buildJsonObject { put("desktopDeviceId", desktopDeviceId) }))
    }
    fun request(session: DeviceSession, request: EnrollmentRequest): EnrollmentRequest =
        EnrollmentRequest.parse(call("requests/${request.requestId}", session.deviceToken))
    fun requests(session: DeviceSession): List<EnrollmentRequest> {
        val values = call("requests", session.deviceToken).array("requests")
        require(values.size <= 128) { "连接申请数量超过限制" }
        return values.map { EnrollmentRequest.parse(it as? JsonObject ?: error("连接申请资料无效")) }
    }
    fun revokeRoom(session: DeviceSession, roomId: String) {
        require(roomId.matches(Regex("^[0-9a-f]{32}$"))) { "房间标识无效" }
        call("rooms/$roomId/revoke", session.deviceToken, buildJsonObject { })
    }
    fun revokeDevice(session: DeviceSession) { call("device", session.deviceToken, delete = true) }
    private fun call(path: String, bearer: String, body: JsonObject? = null, delete: Boolean = false): JsonObject {
        val url = path.split('/').fold(base.newBuilder()) { builder, segment -> builder.addPathSegment(segment) }.build()
        val request = Request.Builder().url(url).header("Authorization", "Bearer $bearer")
        if (delete) request.delete() else if (body != null) request.post(body.toString().toRequestBody(JSON_MEDIA)) else request.get()
        return jsonRequest(client, request.build())
    }
}
