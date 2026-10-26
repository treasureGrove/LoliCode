package art.treasuregrove.lolicode.mobile.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import art.treasuregrove.lolicode.mobile.MainActivity
import art.treasuregrove.lolicode.mobile.R
import art.treasuregrove.lolicode.mobile.data.CredentialStore
import art.treasuregrove.lolicode.mobile.protocol.validSessionId

object TaskNotifications {
    const val CHANNEL = "lolicode_tasks"
    private val kinds = setOf("approval_required", "question_required", "task_completed", "task_failed")

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, "审批与任务结果", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "电脑任务需要审批或已经完成时通知"
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun show(context: Context, data: Map<String, String>) {
        val roomId = data["roomId"].orEmpty()
        val eventId = data["eventId"].orEmpty()
        val sessionId = data["sessionId"].orEmpty()
        val kind = data["kind"].orEmpty()
        if (!roomId.matches(Regex("^[a-f0-9]{32}$")) || eventId.length !in 1..180 ||
            !validSessionId(sessionId) || kind !in kinds) return
        val store = CredentialStore(context)
        if (!runCatching { store.computers().any { it.id == roomId && it.approved } && store.acceptNotice(roomId, eventId) }.getOrDefault(false)) return
        ensureChannel(context)
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("roomId", roomId); putExtra("sessionId", sessionId); putExtra("eventId", eventId)
        }
        val requestCode = "$roomId:$eventId".hashCode()
        val pending = PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val title = when (kind) {
            "approval_required" -> "LoliCode 有操作等待审批"
            "question_required" -> "LoliCode 有问题等待回答"
            "task_completed" -> "LoliCode 任务已完成"
            else -> "LoliCode 任务需要查看"
        }
        val public = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("LoliCode").setContentText("有新的任务通知，解锁后查看").build()
        val notification = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText("解锁手机并打开应用查看最新状态")
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(public)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true)
            .setContentIntent(pending).setCategory(NotificationCompat.CATEGORY_STATUS).build()
        try { NotificationManagerCompat.from(context).notify(requestCode, notification) } catch (_: SecurityException) { }
    }
}
