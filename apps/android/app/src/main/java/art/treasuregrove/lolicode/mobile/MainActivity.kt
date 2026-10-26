package art.treasuregrove.lolicode.mobile

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.viewModels
import art.treasuregrove.lolicode.mobile.ui.CompanionApp
import art.treasuregrove.lolicode.mobile.protocol.validSessionId

class MainActivity : ComponentActivity() {
    private val model: CompanionViewModel by viewModels()
    private var pendingNotice: Pair<String, String>? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The app uses a light palette even when the device is in night mode.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        captureNotice(intent)
        setContent { CompanionApp(model) }
    }
    override fun onStart() {
        super.onStart()
        if (!getSystemService(KeyguardManager::class.java).isDeviceLocked) model.foreground()
    }
    override fun onStop() { model.background(); super.onStop() }
    override fun onResume() {
        super.onResume()
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceLocked) { model.foreground(); deliverNotice() }
        else if (pendingNotice != null) keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { model.foreground(); deliverNotice() }
        })
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureNotice(intent)
        if (!getSystemService(KeyguardManager::class.java).isDeviceLocked) deliverNotice()
    }
    private fun captureNotice(intent: Intent?) {
        val room = intent?.getStringExtra("roomId") ?: return
        val session = intent.getStringExtra("sessionId") ?: return
        if (room.matches(Regex("^[a-f0-9]{32}$")) && validSessionId(session)) pendingNotice = room to session
    }
    private fun deliverNotice() {
        if (getSystemService(KeyguardManager::class.java).isDeviceLocked) return
        pendingNotice?.let { (room, session) -> model.openNotification(room, session) }
        pendingNotice = null
        intent.removeExtra("roomId"); intent.removeExtra("sessionId"); intent.removeExtra("eventId")
    }
}
