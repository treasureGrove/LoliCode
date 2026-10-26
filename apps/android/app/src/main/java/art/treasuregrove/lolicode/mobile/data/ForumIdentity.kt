package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

data class AccountProfile(val id: String, val username: String, val displayName: String) {
    fun toJson() = buildJsonObject { put("id", id); put("username", username); put("displayName", displayName) }
    companion object {
        fun parse(value: JsonObject): AccountProfile {
            val id = value.string("id")
            require(validAccountId(id)) { "账号资料无效" }
            val username = value.string("username").takeIf { it.isNotBlank() && it.length <= 512 } ?: error("账号资料无效")
            return AccountProfile(id, username, value.string("displayName").ifBlank { username }.take(512))
        }
    }
}

/** Never a data class: generated toString/copy diagnostics must not expose tokens. */
class ForumCredential(val account: AccountProfile, val token: String) {
    init { require(validAccountId(account.id) && token.matches(Regex("^[A-Za-z0-9]{40}$"))) { "账号凭据无效" } }
    val bearer get() = "lc1.${account.id}.$token"
    fun toJson() = buildJsonObject { put("account", account.toJson()); put("token", token) }
    override fun toString() = "ForumCredential(account=${account.id}, token=[redacted])"
    companion object { fun parse(value: JsonObject) = ForumCredential(AccountProfile.parse(value.getValue("account").jsonObject), value.string("token")) }
}

fun validAccountId(id: String) = id.matches(Regex("^[1-9][0-9]{0,16}$"))

/** The password is forwarded once over TLS and is never retained by this client. */
class ForumIdentity(private val origin: HttpUrl = "https://lolicode.com/".toHttpUrl(), allowLocal: Boolean = false) {
    init { require((origin.isHttps || (allowLocal && origin.host in listOf("127.0.0.1", "localhost", "::1"))) && origin.username.isEmpty() && origin.password.isEmpty() && origin.query == null && origin.fragment == null) { "账号连接必须使用 HTTPS" } }
    private val client = accountHttpClient()
    fun login(identification: String, password: String): ForumCredential {
        require(identification.isNotBlank() && identification.length <= 320 && identification.none { it.isISOControl() } && password.isNotEmpty() && password.toByteArray().size <= 4096) { "请输入有效的用户名或邮箱及密码" }
        val response = jsonRequest(client, Request.Builder().url(origin.resolve("api/token")!!).post(buildJsonObject {
            put("identification", identification.trim()); put("password", password); put("remember", true)
        }.toString().toRequestBody(JSON_MEDIA)).build(), 16 * 1024, login = true)
        val id = response.string("userId")
        val token = response.string("token")
        require(validAccountId(id) && token.matches(Regex("^[A-Za-z0-9]{40}$"))) { "账号服务返回无效凭据" }
        // Invalid Flarum tokens may receive a public profile with HTTP 200. Only
        // self-only serializer fields prove that this credential was accepted.
        val profile = profile(id, token)
        return ForumCredential(profile, token)
    }
    fun profile(id: String, token: String): AccountProfile {
        require(validAccountId(id) && token.matches(Regex("^[A-Za-z0-9]{40}$"))) { "账号凭据无效" }
        val response = jsonRequest(client, Request.Builder().url(origin.resolve("api/users/$id")!!).header("Authorization", "Token $token").get().build(), 128 * 1024)
        val user = response["data"] as? JsonObject ?: error("账号资料无效")
        val attributes = user["attributes"] as? JsonObject ?: error("账号资料无效")
        require(user.string("type") == "users" && user.string("id") == id &&
            (attributes["isEmailConfirmed"] as? JsonPrimitive)?.booleanOrNull != null &&
            (attributes["isAdmin"] as? JsonPrimitive)?.booleanOrNull != null &&
            (attributes["email"] as? JsonPrimitive)?.isString == true) { "登录已失效，请重新登录 LoliCode" }
        val username = attributes.string("username")
        require(username.isNotBlank() && username.length <= 512) { "账号资料无效" }
        return AccountProfile(id, username, attributes.string("displayName").ifBlank { attributes.string("nickname") }.ifBlank { username }.take(512))
    }
}

internal val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
internal fun accountHttpClient() = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

internal fun jsonRequest(client: OkHttpClient, request: Request, limit: Int = 256 * 1024, login: Boolean = false): JsonObject {
    try {
        client.newCall(request.newBuilder().header("Accept", "application/json").build()).execute().use { response ->
            if (response.code in listOf(400, 401, 403, 422) && login) throw AccountExpired("用户名、邮箱或密码不正确，或账号不可用")
            if (response.code in listOf(401, 403)) throw AccountExpired("账号会话已失效，请重新登录")
            if (!response.isSuccessful) throw IOException(if (response.code == 429) "请求过于频繁，请稍后重试" else "账号设备服务暂时不可用")
            val body = response.body ?: throw IOException("账号服务返回空响应")
            require(body.contentLength() <= limit || body.contentLength() < 0) { "账号响应超过大小限制" }
            val output = ByteArrayOutputStream()
            body.byteStream().use { stream ->
                val buffer = ByteArray(4096)
                while (true) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    require(read <= limit - output.size()) { "账号响应超过大小限制" }
                    output.write(buffer, 0, read)
                }
            }
            return try { wireJson.parseToJsonElement(output.toString("UTF-8")) as? JsonObject ?: error("账号响应格式无效") }
            catch (_: kotlinx.serialization.SerializationException) { throw IllegalArgumentException("账号响应格式无效") }
        }
    } catch (failure: AccountExpired) { throw failure }
    catch (failure: IOException) { throw IOException("无法连接账号设备服务，请检查网络后重试") }
}

class AccountExpired(message: String) : IllegalStateException(message)
