package art.treasuregrove.lolicode.mobile

import android.app.Application
import art.treasuregrove.lolicode.mobile.push.TaskNotifications

class CompanionApplication : Application() {
    override fun onCreate() { super.onCreate(); TaskNotifications.ensureChannel(this) }
}
