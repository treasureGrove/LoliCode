package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.R
import art.treasuregrove.lolicode.mobile.data.*

@Composable
internal fun TaskListScreen(state: CompanionState, onNewTask: () -> Unit, onDevices: () -> Unit, onOpenSession: (String) -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    val sessions = state.sessions.filter { search.isBlank() || it.title.contains(search, ignoreCase = true) || it.projectPath.contains(search, ignoreCase = true) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (state.computers.isEmpty()) item { EmptyTasks("让想法，成为进展。", "连接电脑后，你的任务和会话将在这里。", "连接我的电脑", onDevices) }
        else {
            item {
                Row(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(LoliColors.VioletSoft, LoliColors.RoseSoft.copy(alpha = 0.75f))), RoundedCornerShape(24.dp)).padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            AppGlyph(Glyph.Sparkle, tint = LoliColors.Violet, size = 18.dp)
                            Text("任务记录", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        }
                        Text("${state.computer?.name ?: "当前设备"} · ${if (state.sessions.isEmpty() && !state.usable) "连接后同步会话" else "${state.sessions.size} 个会话"}", style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    FilledTonalButton(onClick = onNewTask, shape = RoundedCornerShape(16.dp), colors = ButtonDefaults.filledTonalButtonColors(containerColor = Color.White.copy(alpha = 0.85f), contentColor = LoliColors.Rose)) { AppGlyph(Glyph.Plus, tint = LoliColors.Rose, size = 17.dp); Spacer(Modifier.width(4.dp)); Text("新任务") }
                }
            }
            if (state.sessions.isNotEmpty()) item {
                OutlinedTextField(value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth().testTag("task_search"), singleLine = true,
                    placeholder = { Text("搜索会话或项目", style = MaterialTheme.typography.bodyMedium) }, leadingIcon = { AppGlyph(Glyph.Search, size = 20.dp) },
                    shape = RoundedCornerShape(20.dp), colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = Color.White.copy(alpha = 0.9f), unfocusedBorderColor = LoliColors.Line, focusedBorderColor = LoliColors.Violet))
            }
            if (!state.usable) item { OfflineNotice() }
            if (state.sessions.isEmpty()) item { EmptyTasks("第一件事，从这里开始。", "创建会话，选择项目，再告诉电脑你想做什么。", "新建任务", onNewTask) }
            else if (sessions.isEmpty()) item { Text("没有找到相关会话，试试其他关键词。", modifier = Modifier.padding(vertical = 28.dp), color = LoliColors.Muted) }
            else items(sessions, key = { it.id }) { session ->
                SessionRow(session, state.snapshot?.takeIf { it.session.id == session.id }, enabled = !state.busy || state.selectedSession == session.id, onClick = { onOpenSession(session.id) })
            }
        }
    }
}

@Composable
private fun EmptyTasks(title: String, body: String, button: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 38.dp, bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Box(Modifier.size(122.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(92.dp).rotate(-10f).background(LoliColors.VioletSoft, RoundedCornerShape(27.dp)))
            Surface(Modifier.size(90.dp).rotate(5f), shape = RoundedCornerShape(27.dp), color = Color.White, border = BorderStroke(1.dp, LoliColors.RoseSoft), shadowElevation = 2.dp) {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color.White, LoliColors.RoseSoft.copy(alpha = 0.55f)))), contentAlignment = Alignment.Center) { AppGlyph(Glyph.Tasks, size = 43.dp, tint = LoliColors.Rose) }
            }
            AppGlyph(Glyph.Sparkle, Modifier.align(Alignment.TopEnd), tint = LoliColors.Violet, size = 21.dp)
            AppGlyph(Glyph.Sparkle, Modifier.align(Alignment.BottomStart), tint = LoliColors.Rose.copy(alpha = 0.6f), size = 15.dp)
        }
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Text(body, color = LoliColors.Muted, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
        Button(onClick = onClick, modifier = Modifier.heightIn(min = 52.dp), shape = RoundedCornerShape(18.dp)) { AppGlyph(Glyph.Plus, tint = Color.White, size = 17.dp); Spacer(Modifier.width(7.dp)); Text(button) }
    }
}

@Composable
internal fun SessionRow(session: Session, snapshot: SessionSnapshot?, enabled: Boolean = true, onClick: () -> Unit) {
    LoliCard(Modifier.testTag("task_${session.id}").alpha(if (enabled) 1f else 0.6f), onClick = if (enabled) onClick else null) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GlyphTile(if (snapshot?.status?.startsWith("waiting") == true) Glyph.Shield else Glyph.Tasks,
                color = if (snapshot?.status?.startsWith("waiting") == true) LoliColors.Amber else LoliColors.Rose,
                background = if (snapshot?.status?.startsWith("waiting") == true) LoliColors.AmberSoft else LoliColors.RoseSoft)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(session.title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(5.dp).background(if (snapshot != null) statusColor(snapshot.status) else LoliColors.Muted.copy(alpha = 0.5f), CircleShape))
                    Text(if (snapshot != null) statusLabel(snapshot.status) else "查看记录", color = if (snapshot != null) statusColor(snapshot.status) else LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
                    Text("·", color = LoliColors.Muted)
                    Text(projectName(session.projectPath), style = MaterialTheme.typography.labelSmall, color = LoliColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
            }
            Spacer(Modifier.width(6.dp)); AppGlyph(Glyph.Right, size = 16.dp)
        }
    }
}

@Composable
internal fun TaskDetailScreen(state: CompanionState, snapshot: SessionSnapshot?, actions: CompanionActions) {
    LazyColumn(Modifier.fillMaxSize().testTag("task_detail"), contentPadding = PaddingValues(horizontal = 18.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (!state.usable) item { OfflineNotice() }
        if (snapshot == null) item {
            LoliCard {
                Text("正在读取电脑上的任务", fontWeight = FontWeight.Medium)
                Text("进度和审批以电脑返回的最新状态为准。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                if (state.usable) LinearProgressIndicator(Modifier.fillMaxWidth(), color = LoliColors.Rose, trackColor = LoliColors.RoseSoft)
            }
        } else {
            item {
                Row(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(LoliColors.RoseSoft.copy(alpha = 0.6f), LoliColors.VioletSoft.copy(alpha = 0.7f))), RoundedCornerShape(18.dp)).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusPill(statusLabel(snapshot.status), statusColor(snapshot.status), when {
                        snapshot.status.startsWith("waiting") -> LoliColors.AmberSoft
                        snapshot.status == "idle" -> LoliColors.GreenSoft
                        else -> LoliColors.RoseSoft
                    })
                    Spacer(Modifier.weight(1f))
                    AppGlyph(Glyph.File, size = 13.dp); Spacer(Modifier.width(5.dp))
                    Text(projectName(snapshot.session.projectPath), modifier = Modifier.widthIn(max = 150.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
                }
            }
            items(snapshot.approvals, key = { "approval-${it.id}" }) { approval -> ApprovalCard(approval, state.usable && !state.busy, actions) }
            items(snapshot.questions, key = { "question-${it.id}" }) { question -> QuestionCard(question, state.usable && !state.busy) { actions.replyQuestion(question.id, it) } }
            if (snapshot.status == "running") item {
                LoliCard(color = LoliColors.VioletSoft.copy(alpha = 0.55f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GlyphTile(Glyph.Sparkle, color = LoliColors.Violet, background = Color.White, size = 38.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("正在电脑上执行", fontWeight = FontWeight.SemiBold)
                            Text("你可以离开此页，任务会继续。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    if (state.usable) LinearProgressIndicator(Modifier.fillMaxWidth().height(3.dp), color = LoliColors.Violet, trackColor = Color.White)
                }
            }
            if (snapshot.error.isNotBlank()) item { Text(snapshot.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            if (snapshot.messages.isEmpty() && snapshot.status == "idle") item {
                Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    GlyphTile(Glyph.Sparkle, size = 56.dp)
                    Text("准备好了，写下你的想法。", fontWeight = FontWeight.Medium)
                    Text("文件、项目与执行，都在你的电脑上。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (snapshot.messages.isNotEmpty()) item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    AppGlyph(Glyph.Sparkle, size = 13.dp, tint = LoliColors.Violet)
                    Text("任务记录", color = LoliColors.Violet, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
                }
            }
            items(snapshot.messages) { message -> MessageCard(message) }
            if (snapshot.diffs.isNotEmpty()) item { SectionHeading("文件变更 · ${snapshot.diffs.size}") }
            items(snapshot.diffs) { diff ->
                var expanded by rememberSaveable(snapshot.session.id, diff.path) { mutableStateOf(false) }
                LoliCard {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        AppGlyph(Glyph.File, size = 18.dp, tint = LoliColors.Rose); Spacer(Modifier.width(9.dp))
                        Text(diff.path, Modifier.weight(1f), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起" else "查看") }
                    }
                    if (expanded) Surface(color = LoliColors.VioletSoft.copy(alpha = 0.5f), shape = RoundedCornerShape(14.dp)) {
                        SelectionContainer { Text(diff.patch, modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(12.dp), fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 19.sp) }
                    }
                }
            }
            if (snapshot.truncated) item { Text(snapshot.truncationMessage.ifBlank { "部分较早记录已省略，完整内容请在电脑端查看。" }, color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall) }
            item { Spacer(Modifier.height(2.dp)) }
        }
    }
}

@Composable
internal fun OfflineNotice() {
    Row(Modifier.fillMaxWidth().background(LoliColors.VioletSoft.copy(alpha = 0.7f), RoundedCornerShape(16.dp)).padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
        AppGlyph(Glyph.Devices, tint = LoliColors.Violet, size = 17.dp); Spacer(Modifier.width(9.dp))
        Text("当前未连接电脑。显示的是已同步内容，重新连接后可继续操作。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ApprovalCard(approval: Approval, enabled: Boolean, actions: CompanionActions) {
    LoliCard(color = Color(0xFFFFF9EF)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GlyphTile(Glyph.Shield, LoliColors.Amber, Color.White, 40.dp); Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("需要你的确认", color = LoliColors.Amber, fontWeight = FontWeight.SemiBold)
                Text("此任务正在等待审批", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
            }
        }
        Text(approval.action, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
        SelectionContainer { Text(approval.detail, style = MaterialTheme.typography.bodySmall, lineHeight = 20.sp) }
        Text("仅授权本次操作，提交前会重新核对有效性。", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = { actions.replyPermission(approval.id, false) }, enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 50.dp).testTag("approval_reject_${approval.id}"), shape = RoundedCornerShape(14.dp)) { Text("拒绝") }
            Button(onClick = { actions.replyPermission(approval.id, true) }, enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 50.dp).testTag("approval_allow_${approval.id}"), shape = RoundedCornerShape(14.dp)) { AppGlyph(Glyph.Check, tint = Color.White, size = 16.dp); Spacer(Modifier.width(6.dp)); Text("允许一次") }
        }
    }
}

@Composable
private fun MessageCard(message: ChatMessage) {
    if (message.role == "user") {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(modifier = Modifier.padding(start = 30.dp), shape = RoundedCornerShape(21.dp, 21.dp, 6.dp, 21.dp), color = LoliColors.RoseSoft, border = BorderStroke(1.dp, Color.White)) {
                Box(Modifier.background(Brush.linearGradient(listOf(LoliColors.RoseSoft, LoliColors.VioletSoft.copy(alpha = 0.7f))))) {
                    SelectionContainer { Text(message.body, modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, lineHeight = 23.sp) }
                }
            }
        }
    } else Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (message.role == "assistant") Image(painter = painterResource(R.drawable.lolicode_avatar), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(30.dp).clip(CircleShape))
            else Box(Modifier.size(28.dp).background(LoliColors.VioletSoft, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) { AppGlyph(Glyph.Code, size = 16.dp, tint = LoliColors.Violet) }
            Text(if (message.role == "assistant") "LoliCode" else "系统", color = LoliColors.Violet, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
        Surface(shape = RoundedCornerShape(6.dp, 21.dp, 21.dp, 21.dp), color = Color.White, border = BorderStroke(1.dp, LoliColors.Line), modifier = Modifier.fillMaxWidth()) {
            SelectionContainer { Text(message.body, modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, lineHeight = 23.sp) }
        }
    }
}

@Composable
internal fun TaskComposer(state: CompanionState, snapshot: SessionSnapshot?, actions: CompanionActions, sessionId: String) {
    var draft by rememberSaveable(state.selectedRoom, sessionId) { mutableStateOf("") }
    val running = snapshot?.status in setOf("running", "waiting_permission", "waiting_question")
    Surface(color = Color.White.copy(alpha = 0.98f), shadowElevation = 3.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (running) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(5.dp).background(statusColor(snapshot?.status), CircleShape)); Spacer(Modifier.width(6.dp))
                Text(if (snapshot?.status == "running") "电脑正在处理这项任务" else "先处理上方待办，再继续对话", color = LoliColors.Muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = actions.cancel, enabled = state.usable && !state.busy, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("停止任务", style = MaterialTheme.typography.labelMedium) }
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                OutlinedTextField(draft, { draft = it }, modifier = Modifier.weight(1f).testTag("task_composer"), placeholder = { Text("告诉电脑，接下来做什么…", style = MaterialTheme.typography.bodyMedium) },
                    minLines = 1, maxLines = 4, enabled = !state.busy, shape = RoundedCornerShape(20.dp),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = LoliColors.Line, focusedBorderColor = LoliColors.Violet, unfocusedContainerColor = LoliColors.VioletSoft.copy(alpha = 0.35f), focusedContainerColor = LoliColors.RoseSoft.copy(alpha = 0.35f)))
                FilledIconButton(onClick = { actions.sendMessage(draft) { draft = "" } }, enabled = state.usable && !state.busy && state.selectedSession == sessionId && draft.isNotBlank() && !running && snapshot != null,
                    modifier = Modifier.size(52.dp).testTag("send_task"), shape = RoundedCornerShape(17.dp)) { AppGlyph(Glyph.Send, tint = if (state.usable && !running && draft.isNotBlank()) Color.White else LoliColors.Muted, description = "发送任务") }
            }
        }
    }
}
