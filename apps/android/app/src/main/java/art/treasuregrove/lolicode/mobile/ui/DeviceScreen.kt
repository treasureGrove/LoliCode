package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import art.treasuregrove.lolicode.mobile.BuildConfig
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.data.PairedComputer
import art.treasuregrove.lolicode.mobile.data.DevicePresence

@Composable
internal fun DeviceScreen(state: CompanionState, actions: CompanionActions, notificationsAllowed: Boolean, onLogin: () -> Unit, onForget: (PairedComputer) -> Unit, onHelp: () -> Unit) {
    DisposableEffect(Unit) {
        actions.enrollmentVisibility(true)
        onDispose { actions.enrollmentVisibility(false) }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            LoliCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    GlyphTile(Glyph.Shield, color = LoliColors.Violet, background = LoliColors.VioletSoft, size = 42.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(state.account?.displayName ?: "登录 LoliCode", fontWeight = FontWeight.SemiBold)
                        Text(state.account?.let { "@${it.username} · 同账号设备" } ?: "与电脑使用同一账号发现设备", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                    }
                    if (state.account == null) TextButton(onClick = onLogin, enabled = !state.accountBusy, modifier = Modifier.testTag("account_login")) { Text("登录") }
                    else TextButton(onClick = actions.logout, modifier = Modifier.testTag("account_logout")) { Text("退出登录") }
                }
                Text("账号服务仅协调设备与信令，任务通过独立加密直连传输。直连不可用时不会转经服务器。", style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
                ComputerStatusPill(state)
                if (state.transport != "direct") Text(state.connection, style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
            }
        }
        if (state.account != null) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("同账号电脑", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    TextButton(onClick = actions.discoverComputers, enabled = !state.accountBusy, modifier = Modifier.testTag("account_discover")) { Text("刷新") }
                }
            }
            if (state.discoveredComputers.none { it.kind == "desktop" }) item {
                LoliCard {
                    Text("暂未发现电脑", fontWeight = FontWeight.SemiBold)
                    Text("请在电脑端登录相同账号并开启手机连接，再刷新。在线表示近期登录设备服务，连接后还会验证电脑任务状态。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            items(state.discoveredComputers.filter { it.kind == "desktop" }, key = { "account:${it.deviceId}" }) { device ->
                val presence = state.presence(device)
                val selected = state.computer?.desktopDeviceId == device.deviceId && state.computer?.desktopFingerprint == device.fingerprint
                LoliCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlyphTile(Glyph.Devices, color = if (presence == DevicePresence.Online) LoliColors.Green else LoliColors.Muted, background = if (presence == DevicePresence.Online) LoliColors.GreenSoft else LoliColors.VioletSoft, size = 42.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(device.deviceName, fontWeight = FontWeight.SemiBold)
                            Text(deviceStatusText(presence, selected && state.transport == "direct", selected && state.hostVerified, limitedText = selected && state.transport == "text"), color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                            Text("指纹 ${shortFingerprint(device.fingerprint)}", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    Button(onClick = { actions.requestConnection(device.deviceId) }, enabled = !state.accountBusy && !(state.enrollment?.status == "pending" && state.enrollment.desktop.deviceId == device.deviceId), modifier = Modifier.fillMaxWidth().testTag("connect_${device.deviceId}"), shape = RoundedCornerShape(14.dp)) {
                        Text(if (state.enrollment?.status == "pending" && state.enrollment.desktop.deviceId == device.deviceId) "等待电脑授权" else "请求连接")
                    }
                }
            }
            state.enrollment?.let { enrollment -> item(key = "enrollment:${enrollment.requestId}") {
                LoliCard(color = LoliColors.VioletSoft.copy(alpha = 0.5f)) {
                    Text(when (enrollment.status) { "approved" -> "电脑已确认连接"; "rejected" -> "电脑已拒绝本次连接"; else -> "等待电脑授权" }, fontWeight = FontWeight.SemiBold)
                    Text(enrollment.desktop.deviceName, style = MaterialTheme.typography.bodyMedium)
                    Text("电脑指纹 ${shortFingerprint(enrollment.desktop.fingerprint)}\n手机指纹 ${shortFingerprint(enrollment.phone.fingerprint)}", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                    if (enrollment.status == "pending") Text("请在电脑核对设备后确认。本次请求五分钟内有效，等待时会自动刷新。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
            } }
        }
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("连接的电脑", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                TextButton(onClick = onHelp) { AppGlyph(Glyph.Question, tint = LoliColors.Rose, size = 17.dp); Spacer(Modifier.width(5.dp)); Text("连接帮助") }
            }
        }
        if (state.computers.isEmpty()) item {
            LoliCard(color = LoliColors.VioletSoft.copy(alpha = 0.5f)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    GlyphTile(Glyph.Devices, color = LoliColors.Violet, background = Color.White, size = 52.dp)
                    Spacer(Modifier.weight(1f))
                    AppGlyph(Glyph.Sparkle, tint = LoliColors.Violet.copy(alpha = 0.6f), size = 22.dp)
                }
                Text("随时连接，安心交给电脑。", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                Text("登录相同账号发现电脑，发起连接后在电脑确认授权，再建立原生加密直连。", color = LoliColors.Muted, style = MaterialTheme.typography.bodyMedium)
            }
        }
        items(state.computers, key = { it.id }) { computer ->
            val selected = computer.id == state.selectedRoom
            val presence = state.presence(computer)
            LoliCard(onClick = { if (!selected && !state.busy) actions.selectComputer(computer.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    GlyphTile(Glyph.Devices, if (presence == DevicePresence.Online) LoliColors.Green else LoliColors.Muted, if (presence == DevicePresence.Online) LoliColors.GreenSoft else LoliColors.VioletSoft, 48.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(computer.name, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(deviceStatusText(presence, selected && state.transport == "direct", selected && state.hostVerified, computer.approved, selected && state.transport == "text"), color = if (presence == DevicePresence.Online) LoliColors.Green else LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                    }
                    if (selected) Box(Modifier.size(27.dp).background(Brush.linearGradient(listOf(LoliColors.RoseSoft, LoliColors.VioletSoft)), CircleShape), contentAlignment = Alignment.Center) { AppGlyph(Glyph.Check, tint = LoliColors.Rose, size = 14.dp) }
                    else AppGlyph(Glyph.Right, size = 16.dp)
                }
                if (selected) {
                    HorizontalDivider(color = LoliColors.Line)
                    Text(state.connection, color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        OutlinedButton(onClick = actions.reconnect, enabled = !state.busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp), shape = RoundedCornerShape(13.dp)) { AppGlyph(Glyph.Refresh, tint = LoliColors.Rose, size = 16.dp); Spacer(Modifier.width(7.dp)); Text("重新连接") }
                        TextButton(onClick = { onForget(computer) }, enabled = !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("移除设备", color = LoliColors.Muted) }
                    }
                }
            }
        }
        item {
            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AppGlyph(Glyph.Sparkle, tint = LoliColors.Violet, size = 15.dp)
                Text("连接与偏好", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }
        }
        item {
            LoliCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    GlyphTile(Glyph.Bell, color = LoliColors.Amber, background = LoliColors.AmberSoft, size = 38.dp); Spacer(Modifier.width(11.dp))
                    Text("审批与完成通知", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                }
                val label = when {
                    !BuildConfig.PUSH_CONFIGURED -> "系统推送暂未启用"
                    !notificationsAllowed -> "通知权限未开启"
                    state.pushError != null -> state.pushError
                    !state.pushConfigured -> "中转服务未配置 FCM"
                    !state.pushRegistered -> "等待注册系统推送"
                    else -> "推送已配置，待真机验证"
                }
                StatusPill(label.orEmpty(), LoliColors.Amber, LoliColors.AmberSoft, dot = false)
                Text(if (!BuildConfig.PUSH_CONFIGURED) "当前测试版仅在应用前台查看审批和完成状态。手机锁屏后不会收到系统通知；再次打开应用会读取最新进度。" else "通知不包含任务正文。解锁并打开应用后，将重新核对任务与审批状态。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                if (BuildConfig.PUSH_CONFIGURED && !notificationsAllowed) OutlinedButton(onClick = actions.requestNotifications) { Text("开启通知权限") }
            }
        }
        item {
            LoliCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    GlyphTile(Glyph.Shield, color = LoliColors.Violet, background = LoliColors.VioletSoft, size = 38.dp); Spacer(Modifier.width(11.dp))
                    Text("电脑静默执行", fontWeight = FontWeight.SemiBold)
                }
                Text("远程任务不弹出电脑窗口，也不抢占焦点。电脑保持开机、联网，且 LoliCode 在后台运行时，可在锁屏后继续执行支持的任务。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                HorizontalDivider(color = LoliColors.Line)
                CapabilityLine("当前支持", "文件读写、模型请求与逐次审批")
                CapabilityLine("暂不支持", "终端命令、桌面交互与鼠标键盘接管")
            }
        }
        item {
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    AppGlyph(Glyph.Sparkle, tint = LoliColors.Rose, size = 12.dp)
                    Text("LoliCode · ${BuildConfig.VERSION_NAME}", color = LoliColors.Violet, style = MaterialTheme.typography.labelMedium)
                }
                Text("任务和模型密钥保存在电脑上", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

private fun shortFingerprint(value: String) = value.take(16).chunked(4).joinToString(" ")

@Composable
private fun CapabilityLine(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(label, modifier = Modifier.background(LoliColors.VioletSoft.copy(alpha = 0.7f), RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 3.dp), color = LoliColors.Violet, style = MaterialTheme.typography.labelMedium)
        Text(value, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PairingHelpSheet(onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = LoliColors.Background) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            AppGlyph(Glyph.Sparkle, tint = LoliColors.Violet, size = 25.dp)
            Text("让手机和电脑认识一下", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            listOf("登录同一账号" to "在手机与电脑登录相同的 LoliCode 账号，并在电脑开启手机连接。", "发现电脑并请求连接" to "在设备页刷新同账号电脑，选择电脑后请求连接。", "回到电脑确认" to "在电脑核对设备名称与指纹后授权。", "建立原生直连" to "账号服务仅协调设备与信令，任务通过独立加密直连传输。直连不可用时不会转经服务器，请切换网络后重试。")
                .forEachIndexed { index, (title, body) -> Row(horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                    Box(Modifier.size(30.dp).background(LoliColors.RoseSoft, CircleShape), contentAlignment = Alignment.Center) { Text("${index + 1}", color = LoliColors.Rose, fontWeight = FontWeight.SemiBold) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(title, fontWeight = FontWeight.SemiBold); Text(body, color = LoliColors.Muted, style = MaterialTheme.typography.bodyMedium) }
                } }
            Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(16.dp)) { Text("明白了") }
        }
    }
}
