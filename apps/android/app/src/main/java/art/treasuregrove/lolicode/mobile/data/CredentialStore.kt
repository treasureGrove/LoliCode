package art.treasuregrove.lolicode.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import art.treasuregrove.lolicode.mobile.BuildConfig
import art.treasuregrove.lolicode.mobile.protocol.*
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.*

/** Only AES-GCM ciphertext and IV enter SharedPreferences. Backups are disabled. */
class CredentialStore(context: Context, namespace: String = "companion_sealed") {
    private val preferences = context.applicationContext.getSharedPreferences(namespace, Context.MODE_PRIVATE)
    private val lock = Companion

    fun computers(accountId: String? = null): List<PairedComputer> = synchronized(lock) {
        val source = if (accountId == null) read() else account(read(), accountId)
        source.array("computers").map { item ->
            val obj = item.jsonObject
            require(obj.string("accountId").ifBlank { null } == accountId) { "保存的电脑账号归属不匹配" }
            PairedComputer(Pairing.parse(obj.getValue("pairing").toString(), allowLocal = BuildConfig.ALLOW_LOCAL_RELAY, enrollment = false), obj.string("deviceId"), obj.boolean("approved"),
                accountId, obj.string("desktopDeviceId").ifBlank { null }, obj.string("desktopFingerprint").ifBlank { null })
        }
    }

    fun upsert(computer: PairedComputer) = synchronized(lock) {
        val data = read()
        val source = computer.accountId?.let { account(data, it) } ?: data
        computer.accountId?.let { id ->
            require(data.string("activeAccount") == id && validAccountId(id) &&
                (source["identity"] as? JsonObject)?.string("deviceId") == computer.deviceId &&
                computer.approved && validDeviceId(computer.desktopDeviceId.orEmpty()) &&
                computer.desktopFingerprint?.matches(Regex("^[0-9a-f]{64}$")) == true) { "电脑凭据不属于当前账号设备" }
        }
        computer.desktopDeviceId?.let { desktop ->
            val peer = source.array("computers").map { it.jsonObject }.firstOrNull { it.string("desktopDeviceId") == desktop }
            require(peer == null || peer.string("desktopFingerprint") == computer.desktopFingerprint) { "电脑身份密钥发生变化，请先移除旧设备并在电脑重新授权" }
        }
        val items = source.array("computers").filter { it.jsonObject.getValue("pairing").jsonObject.string("roomId") != computer.id } + computer.toJson()
        require(items.size <= 16) { "最多保存 16 台电脑，请先移除旧设备" }
        val updated = JsonObject(source + ("computers" to JsonArray(items)))
        write(computer.accountId?.let { replaceAccount(data, it, updated) } ?: updated)
    }

    fun remove(roomId: String, accountId: String? = null) = synchronized(lock) {
        val data = read()
        val source = accountId?.let { account(data, it) } ?: data
        val updated = JsonObject(source + ("computers" to JsonArray(source.array("computers").filter { it.jsonObject.getValue("pairing").jsonObject.string("roomId") != roomId })))
        write(accountId?.let { replaceAccount(data, it, updated) } ?: updated)
    }

    fun activeCredential(): ForumCredential? = synchronized(lock) {
        val data = read(); val id = data.string("activeAccount")
        if (id.isBlank()) null else (account(data, id)["credential"] as? JsonObject)?.let(ForumCredential::parse)?.also {
            require(it.account.id == id) { "保存的账号归属不匹配" }
        }
    }

    fun saveAccount(credential: ForumCredential) = synchronized(lock) {
        val data = read(); val id = credential.account.id
        write(JsonObject(replaceAccount(data, id, JsonObject(account(data, id) + ("credential" to credential.toJson()))) + ("activeAccount" to text(id))))
    }

    fun accountIdentity(id: String): StoredIdentity = synchronized(lock) {
        require(validAccountId(id)) { "账号标识无效" }
        val data = read(); val source = account(data, id)
        val stored = source["identity"] as? JsonObject
        if (stored != null) {
            val deviceId = stored.string("deviceId"); require(validDeviceId(deviceId)) { "设备标识无效" }
            StoredIdentity(deviceId, DeviceIdentity.restore(stored.string("privateKey"), stored.string("publicKey")))
        } else {
            val identity = DeviceIdentity.generate(); val deviceId = UUID.randomUUID().toString()
            write(replaceAccount(data, id, JsonObject(source + ("identity" to buildJsonObject {
                put("deviceId", deviceId); put("privateKey", identity.privatePkcs8()); put("publicKey", identity.publicKeySpki)
            }))))
            StoredIdentity(deviceId, identity)
        }
    }

    fun logoutAccount() = synchronized(lock) {
        val data = read(); val id = data.string("activeAccount")
        val updated = if (id.isNotBlank()) replaceAccount(data, id, JsonObject(account(data, id) - "credential")) else data
        write(JsonObject(updated - "activeAccount"))
    }

    private fun account(data: JsonObject, id: String) = (data["accounts"] as? JsonObject)?.get(id) as? JsonObject ?: buildJsonObject { }
    private fun replaceAccount(data: JsonObject, id: String, value: JsonObject): JsonObject {
        val accounts = data["accounts"] as? JsonObject ?: buildJsonObject { }
        require(id in accounts || accounts.size < 16) { "保存的账号数量超过限制" }
        return JsonObject(data + ("accounts" to JsonObject(accounts + (id to value))))
    }

    fun deviceId(): String = synchronized(lock) {
        val data = read()
        data.string("deviceId").ifBlank {
            UUID.randomUUID().toString().also { write(JsonObject(data + ("deviceId" to text(it)))) }
        }
    }

    fun pushToken(): String = synchronized(lock) { read().string("pushToken") }
    fun savePushToken(token: String) = synchronized(lock) { write(JsonObject(read() + ("pushToken" to text(token)))) }

    fun acceptNotice(roomId: String, eventId: String): Boolean = synchronized(lock) {
        val data = read()
        val id = "$roomId:$eventId"
        val recent = data.array("notices").map { it.jsonPrimitive.content }
        if (id in recent) return false
        write(JsonObject(data + ("notices" to JsonArray((recent + id).takeLast(256).map(::text)))))
        true
    }

    private fun read(): JsonObject {
        val sealed = preferences.getString("sealed", null) ?: return buildJsonObject { }
        val chunks = sealed.split('.')
        require(chunks.size == 2) { "保存的设备凭据损坏，请重新配对" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, decodeBase64(chunks[0])))
        return wireJson.parseToJsonElement(cipher.doFinal(decodeBase64(chunks[1])).toString(Charsets.UTF_8)).jsonObject
    }

    private fun write(data: JsonObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(data.toString().toByteArray(Charsets.UTF_8))
        check(preferences.edit().putString("sealed", "${encodeBase64(cipher.iv)}.${encodeBase64(ciphertext)}").commit()) { "保存设备凭据失败" }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    companion object { private const val ALIAS = "lolicode.companion.credentials.v1" }
}

class StoredIdentity(val deviceId: String, val identity: DeviceIdentity) {
    override fun toString() = "StoredIdentity(deviceId=$deviceId, private=[redacted])"
}
