package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** Password state is deliberately neither saveable nor part of the ViewModel. */
@Composable
internal fun AccountLoginDialog(onDismiss: () -> Unit, onLogin: (String, String) -> Unit) {
    var identification by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) password = "" }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); password = "" }
    }
    fun dismiss() { password = ""; onDismiss() }
    AlertDialog(
        onDismissRequest = ::dismiss,
        properties = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn),
        title = { Text("登录 LoliCode") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("使用电脑端相同的 LoliCode 账号发现电脑。首次连接须在电脑确认，再建立独立加密的原生直连。")
                OutlinedTextField(identification, { if (it.length <= 320) identification = it },
                    modifier = Modifier.fillMaxWidth().testTag("account_identification"), singleLine = true,
                    label = { Text("用户名或邮箱") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                OutlinedTextField(password, { if (it.toByteArray().size <= 4096) password = it },
                    modifier = Modifier.fillMaxWidth().testTag("account_password"), singleLine = true,
                    label = { Text("密码") }, visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                Text("密码仅用于本次登录，不会保存到手机。", style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
            }
        },
        confirmButton = { TextButton(onClick = {
            val submitted = password
            password = ""
            onLogin(identification.trim(), submitted)
            onDismiss()
        }, enabled = identification.isNotBlank() && password.isNotEmpty(), modifier = Modifier.testTag("account_login_submit")) { Text("登录") } },
        dismissButton = { TextButton(onClick = ::dismiss) { Text("取消") } },
    )
}
