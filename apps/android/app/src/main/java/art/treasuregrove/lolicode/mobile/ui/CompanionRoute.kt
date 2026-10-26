package art.treasuregrove.lolicode.mobile.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import art.treasuregrove.lolicode.mobile.CompanionViewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/** Runtime route owns Android launchers and state; previews call only the screen. */
@Composable
fun CompanionApp(model: CompanionViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var notificationsAllowed by remember { mutableStateOf(NotificationManagerCompat.from(context).areNotificationsEnabled()) }
    DisposableEffect(context, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) notificationsAllowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsAllowed = it }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(model::pair) }
    CompanionScreen(
        state = state,
        notificationsAllowed = notificationsAllowed,
        actions = CompanionActions(
            enrollmentVisibility = model::enrollmentVisibility,
            login = { identification, password -> model.login(identification, password) },
            logout = { model.logout() },
            discoverComputers = { model.discoverComputers() },
            requestConnection = { model.requestConnection(it) },
            pair = model::pair,
            scan = { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("扫描电脑 LoliCode 的配对二维码").setBeepEnabled(false).setOrientationLocked(false)) },
            selectComputer = model::selectComputer,
            forgetComputer = model::forgetComputer,
            reconnect = model::reconnect,
            selectProject = { model.selectProject(it) },
            selectModel = model::selectModel,
            selectSession = { model.selectSession(it) },
            createSession = { model.createSession() },
            refresh = { model.refresh() },
            clearError = model::clearError,
            replyPermission = { id, allow -> model.replyPermission(id, allow) },
            replyQuestion = { id, answers -> model.replyQuestion(id, answers) },
            sendMessage = { message, accepted -> model.sendMessage(message, accepted) },
            cancel = { model.cancel() },
            requestNotifications = {
                if (Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
            },
        ),
    )
}
