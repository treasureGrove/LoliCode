package art.treasuregrove.lolicode.mobile

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import art.treasuregrove.lolicode.mobile.data.CredentialStore
import java.security.MessageDigest
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Local flags only, through the installed target App's normal credential API. No network or account mutation. */
@RunWith(AndroidJUnit4::class)
class ExistingAccountStatusTest {
    @Test fun reportsPublicDeviceIdentityOnlyWhenExplicitlyRequested() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("existingAccountIdentity") == "1")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val store = CredentialStore(instrumentation.targetContext)
        val credential = store.activeCredential() ?: error("debug App login required")
        // This is the same persistent per-account identity API the real ViewModel uses.
        val device = store.accountIdentity(credential.account.id)
        instrumentation.sendStatus(0, Bundle().apply {
            putString("accountHash", MessageDigest.getInstance("SHA-256")
                .digest("lolicode-auth-status-v1|${credential.account.id}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) })
            putString("phoneDeviceId", device.deviceId)
            putString("phoneFingerprint", device.identity.fingerprint)
            putBoolean("normalAccountIdentityApiUsed", true)
            putBoolean("networkUsed", false)
            putBoolean("privateKeyExported", false)
        })
    }

    @Test fun reportsOnlyLocalLoginAndPairingFlags() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("existingAccountStatus") == "1")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val report = Bundle()
        val store = CredentialStore(instrumentation.targetContext)
        try {
            val credential = store.activeCredential()
            report.putBoolean("readable", true)
            report.putBoolean("loggedIn", credential != null)
            if (credential != null) {
                report.putString("accountHash", MessageDigest.getInstance("SHA-256")
                    .digest("lolicode-auth-status-v1|${credential.account.id}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) })
                val computers = store.computers(credential.account.id)
                report.putInt("savedComputers", computers.size)
                report.putInt("approvedComputers", computers.count { it.approved })
                report.putInt("pinnedComputers", computers.count { it.desktopDeviceId != null && it.desktopFingerprint != null })
            }
        } catch (failure: Exception) {
            report.clear()
            report.putBoolean("readable", false)
            report.putString("failureClass", failure.javaClass.simpleName)
        }
        report.putBoolean("networkUsed", false)
        report.putBoolean("credentialValuesLogged", false)
        instrumentation.sendStatus(0, report)
    }
}
