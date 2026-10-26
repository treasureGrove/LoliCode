package art.treasuregrove.lolicode.mobile.push

import art.treasuregrove.lolicode.mobile.data.CredentialStore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Runs without the Activity or a foreground WebSocket. No task body is pushed. */
class CompanionMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { runCatching { CredentialStore(this).savePushToken(token) } }
    override fun onMessageReceived(message: RemoteMessage) { TaskNotifications.show(this, message.data) }
}
