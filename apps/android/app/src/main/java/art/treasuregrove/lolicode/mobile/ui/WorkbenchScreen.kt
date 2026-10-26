package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.R

@Composable
internal fun WorkbenchScreen(state: CompanionState, onLogin: () -> Unit, onHelp: () -> Unit, onNewTask: () -> Unit, onDevices: () -> Unit, onTasks: () -> Unit, onOpenSession: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        if (state.computers.isEmpty()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    CompanionHero(paired = false)
                    Button(onClick = if (state.account == null) onLogin else onDevices, enabled = !state.accountBusy, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).background(Brush.horizontalGradient(listOf(LoliColors.Rose, LoliColors.Violet)), RoundedCornerShape(18.dp)).testTag(if (state.account == null) "account_login" else "account_devices"), shape = RoundedCornerShape(18.dp), colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent)) {
                        AppGlyph(Glyph.Devices, tint = Color.White); Spacer(Modifier.width(10.dp)); Text(if (state.account == null) "登录 LoliCode" else "查看同账号电脑", fontWeight = FontWeight.SemiBold)
                    }
                    Text(if (state.account == null) "与电脑使用同一账号，发现设备后在电脑确认连接。" else "已登录 ${state.account.displayName}。首次连接仍需电脑确认授权。", color = LoliColors.Muted, style = MaterialTheme.typography.bodyMedium)
                    Text("账号服务仅协调设备与信令，任务通过独立加密直连传输。直连不可用时不会转经服务器。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    WelcomeFeature(Glyph.Devices, "电脑执行")
                    WelcomeFeature(Glyph.Shield, "逐次审批")
                    WelcomeFeature(Glyph.Tasks, "结果随行")
                }
            }
            item { TextButton(onClick = onHelp, modifier = Modifier.fillMaxWidth()) { AppGlyph(Glyph.Question, size = 17.dp); Spacer(Modifier.width(7.dp)); Text("如何连接我的电脑？", color = LoliColors.Muted) } }
        } else {
            item {
                CompanionHero(paired = true)
            }
            item {
                LoliCard(onClick = onDevices) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlyphTile(Glyph.Devices, color = if (state.usable) LoliColors.Green else LoliColors.Rose, background = if (state.usable) LoliColors.GreenSoft else LoliColors.RoseSoft)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(state.computer?.name ?: "选择一台电脑", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(if (state.transport == "direct") "原生直连 · 静默后台执行" else if (state.computer?.approved == false) "请在电脑端确认授权" else "等待直连 · 点此查看设备", style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
                        }
                        AppGlyph(Glyph.Right, size = 18.dp)
                    }
                    if (state.transport != "direct") Text(state.connection, color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                Surface(onClick = onNewTask, shape = RoundedCornerShape(22.dp), color = Color.Transparent, modifier = Modifier.fillMaxWidth().background(Brush.horizontalGradient(listOf(LoliColors.Rose, LoliColors.Violet)), RoundedCornerShape(22.dp)).testTag("new_task")) {
                    Row(Modifier.padding(21.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(46.dp).background(Color.White.copy(alpha = 0.16f), RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) { AppGlyph(Glyph.Plus, tint = Color.White, size = 25.dp) }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(if (state.usable) "新建任务" else "连接电脑，开始任务", color = Color.White, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            Text(if (state.usable) "把下一件事，交给 LoliCode" else "任务将在你的电脑上执行", color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodySmall)
                        }
                        AppGlyph(Glyph.Right, tint = Color.White, size = 18.dp)
                    }
                }
            }
            val snapshot = state.snapshot
            if (snapshot != null && (snapshot.approvals.isNotEmpty() || snapshot.questions.isNotEmpty())) item {
                LoliCard(modifier = Modifier.testTag("pending_approvals"), onClick = { onOpenSession(snapshot.session.id) }, color = LoliColors.AmberSoft) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlyphTile(Glyph.Shield, color = LoliColors.Amber, background = Color.White.copy(alpha = 0.7f))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("有 ${snapshot.approvals.size + snapshot.questions.size} 项等待你处理", fontWeight = FontWeight.SemiBold, color = LoliColors.Amber)
                            Text("确认之后，电脑就能继续工作。", style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
                        }
                        AppGlyph(Glyph.Right, tint = LoliColors.Amber, size = 18.dp)
                    }
                }
            }
            if (snapshot != null) item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionHeading("当前会话", "查看详情", { onOpenSession(snapshot.session.id) })
                    LoliCard(onClick = { onOpenSession(snapshot.session.id) }) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            StatusPill(statusLabel(snapshot.status), statusColor(snapshot.status), if (snapshot.status.startsWith("waiting")) LoliColors.AmberSoft else LoliColors.RoseSoft)
                            Spacer(Modifier.weight(1f))
                            if (!state.usable) Text("上次同步", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
                        }
                        Text(snapshot.session.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(snapshot.messages.lastOrNull { it.role == "assistant" }?.body?.take(220) ?: "任务的最新进度将在这里同步。", color = LoliColors.Muted, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        if (snapshot.status == "running" && state.usable) LinearProgressIndicator(Modifier.fillMaxWidth().height(3.dp), color = LoliColors.Rose, trackColor = LoliColors.RoseSoft)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            AppGlyph(Glyph.File, size = 14.dp); Spacer(Modifier.width(5.dp)); Text(projectName(snapshot.session.projectPath), color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            item { SectionHeading("最近会话", if (state.sessions.isNotEmpty()) "查看全部" else null, onTasks) }
            if (state.sessions.isEmpty()) item {
                LoliCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlyphTile(Glyph.Tasks, color = LoliColors.Muted, background = Color(0xFFF5F0F5))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text("还没有任务", fontWeight = FontWeight.Medium)
                            Text("从一个想法开始，创建你的第一段会话。", style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
                        }
                    }
                }
            } else state.sessions.take(3).forEach { session -> item(key = session.id) {
                SessionRow(session, state.snapshot?.takeIf { it.session.id == session.id }, enabled = !state.busy || state.selectedSession == session.id, onClick = { onOpenSession(session.id) })
            } }
            item { Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) { AppGlyph(Glyph.Shield, size = 13.dp); Spacer(Modifier.width(5.dp)); Text("任务与模型密钥留在电脑", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall) } }
        }
    }
}

@Composable
private fun WelcomeFeature(glyph: Glyph, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(9.dp)) { GlyphTile(glyph, color = LoliColors.Violet, background = LoliColors.VioletSoft, size = 42.dp); Text(label, style = MaterialTheme.typography.labelMedium, color = LoliColors.Muted) }
}

/** Existing LoliCode brand art, bundled locally; it never represents connection state. */
@Composable
private fun CompanionHero(paired: Boolean) {
    val largeType = LocalDensity.current.fontScale > 1.15f
    val heading = if (paired) "今天，想\n完成什么？" else "把灵感带走，\n让电脑继续。"
    val subtitle = if (paired) "让每一个想法，\n都有下一步。" else "和你的电脑，\n保持同一进度。"
    Surface(shape = RoundedCornerShape(26.dp), color = Color.Transparent, border = BorderStroke(1.dp, Color.White), shadowElevation = 2.dp) {
        Box(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(Color(0xFFFFE4F1), Color(0xFFF0E8FF), Color(0xFFFFFAFD))))) {
            if (largeType) Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AnimeRibbon(if (paired) "灵感继续" else "灵感同行", color = LoliColors.Violet)
                Text(heading, fontSize = if (paired) 24.sp else 26.sp, lineHeight = if (paired) 34.sp else 37.sp,
                    fontWeight = FontWeight.Bold, letterSpacing = (-0.6).sp, color = LoliColors.Ink)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(subtitle, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = LoliColors.Muted)
                    Image(painterResource(R.drawable.lolicode_companion), contentDescription = null,
                        modifier = Modifier.size(112.dp, 124.dp), contentScale = ContentScale.Fit)
                }
            } else Row(Modifier.fillMaxWidth().padding(start = 18.dp, top = 16.dp, end = 4.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1.12f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AnimeRibbon(if (paired) "灵感继续" else "灵感同行", color = LoliColors.Violet)
                    Text(heading, fontSize = if (paired) 24.sp else 26.sp, lineHeight = if (paired) 34.sp else 37.sp,
                        fontWeight = FontWeight.Bold, letterSpacing = (-0.6).sp, color = LoliColors.Ink)
                    Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = LoliColors.Muted)
                }
                Image(painterResource(R.drawable.lolicode_companion), contentDescription = null,
                    modifier = Modifier.weight(1f).height(if (paired) 170.dp else 220.dp), contentScale = ContentScale.Fit)
            }
        }
    }
}
