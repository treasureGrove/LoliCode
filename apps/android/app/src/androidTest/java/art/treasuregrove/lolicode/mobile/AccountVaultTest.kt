package art.treasuregrove.lolicode.mobile

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Uses a unique test vault in the isolated .debug package, never user credentials. */
@RunWith(AndroidJUnit4::class)
class AccountVaultTest {
    @Test fun keystoreSealsIndependentAccountKeysAndNeverClaimsLegacyRooms() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val namespace = "account-vault-test-${UUID.randomUUID()}"
        val preferences = context.getSharedPreferences(namespace, Context.MODE_PRIVATE)
        val store = CredentialStore(context, namespace)
        try {
            val legacy = PairedComputer(Pairing("wss://lolicode.com/companion/ws", "a".repeat(32), "b".repeat(64), encodeBase64(ByteArray(32) { 3 }), "Legacy fixture", 0), "legacy-device", true)
            store.upsert(legacy)
            val first = ForumCredential(AccountProfile("7", "first", "First fixture"), "a".repeat(40))
            store.saveAccount(first)
            val identity = store.accountIdentity("7")
            val restored = store.accountIdentity("7")
            assertEquals(identity.deviceId, restored.deviceId)
            assertEquals(identity.identity.fingerprint, restored.identity.fingerprint)
            assertEquals(0, store.computers("7").size)
            assertEquals(listOf(legacy), store.computers())
            val computer = legacy.copy(pairing = legacy.pairing.copy(roomId = "c".repeat(32)), deviceId = identity.deviceId,
                accountId = "7", desktopDeviceId = UUID.randomUUID().toString(), desktopFingerprint = "d".repeat(64))
            store.upsert(computer)
            assertEquals(listOf(computer), store.computers("7"))
            val second = ForumCredential(AccountProfile("8", "second", "Second fixture"), "z".repeat(40))
            store.saveAccount(second)
            val otherIdentity = store.accountIdentity("8")
            assertNotEquals(identity.deviceId, otherIdentity.deviceId)
            assertNotEquals(identity.identity.fingerprint, otherIdentity.identity.fingerprint)
            assertTrue(store.computers("8").isEmpty())
            assertEquals(listOf(computer), store.computers("7"))
            assertThrows(IllegalArgumentException::class.java) { store.upsert(computer) }
            val sealed = preferences.getString("sealed", "")!!
            assertFalse(sealed.contains(first.token)); assertFalse(sealed.contains(otherIdentity.identity.privatePkcs8()))
            assertFalse(sealed.contains(computer.pairing.key)); assertFalse(sealed.contains("First fixture"))
            store.logoutAccount()
            assertNull(store.activeCredential())
            assertEquals(listOf(legacy), store.computers())
            assertEquals(identity.identity.fingerprint, store.accountIdentity("7").identity.fingerprint)
            assertEquals(listOf(computer), store.computers("7"))
        } finally { preferences.edit().clear().commit() }
    }
}
