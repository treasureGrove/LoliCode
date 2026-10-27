package art.treasuregrove.lolicode.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.R
import art.treasuregrove.lolicode.mobile.data.PairedComputer

enum class CompanionTab { Workbench, Tasks, Devices }

/** Business state is supplied by the route; navigation and drafts remain local. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionScreen(
    state: CompanionState,
    actions: CompanionActions = CompanionActions(),
    notificationsAllowed: Boolean = false,
    initialTab: CompanionTab = CompanionTab.Workbench,
    initialTaskDetail: Boolean = false,
) {
    key(state.identityEpoch, state.account?.id) {
        CompanionScreenContent(state, actions, notificationsAllowed, initialTab, initialTaskDetail)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionScreenContent(
    state: CompanionState,
    actions: CompanionActions,
    notificationsAllowed: Boolean,
    initialTab: CompanionTab,
    initialTaskDetail: Boolean,
) {
    var tab by rememberSaveable { mutableStateOf(initialTab) }
    var detailId by rememberSaveable(state.selectedRoom) { mutableStateOf(if (initialTaskDetail) state.selectedSession else null) }
    var loginDialog by remember { mutableStateOf(false) }
    var helpSheet by remember { mutableStateOf(false) }
    var newTaskSheet by remember { mutableStateOf(false) }
    var creatingSession by remember { mutableStateOf(false) }
    var previousSessionId by remember { mutableStateOf<String?>(null) }
    var forget by remember { mutableStateOf<PairedComputer?>(null) }
    val draftHolder = rememberSaveableStateHolder()
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val detail = tab == CompanionTab.Tasks && detailId != null
    val snapshot = state.snapshot?.takeIf { it.session.id == detailId }
    val session = state.sessions.firstOrNull { it.id == detailId } ?: snapshot?.session
    val pending = state.snapshot?.let { it.approvals.size + it.questions.size } ?: 0
    fun openSession(id: String) {
        if (state.busy && state.selectedSession != id) return
        detailId = id; tab = CompanionTab.Tasks
        if (state.selectedSession != id) actions.selectSession(id)
    }
    fun startNewTask() { if (state.usable) newTaskSheet = true else tab = CompanionTab.Devices }

    LaunchedEffect(state.selectedSession, state.busy, state.error) {
        if (creatingSession && state.selectedSession != null && state.selectedSession != previousSessionId) {
            detailId = state.selectedSession; tab = CompanionTab.Tasks; newTaskSheet = false; creatingSession = false
        } else if (creatingSession && state.error != null && !state.busy) creatingSession = false
    }
    BackHandler(enabled = detail || tab != CompanionTab.Workbench) { if (detail) detailId = null else tab = CompanionTab.Workbench }
    LoliTheme {
        Box(Modifier.fillMaxSize()) {
            AnimeBackdrop(Modifier.matchParentSize())
            Scaffold(
                modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding(),
                containerColor = Color.Transparent,
                contentWindowInsets = WindowInsets(0, 0, 0, 0),
                topBar = {
                    Row(Modifier.fillMaxWidth().heightIn(min = 68.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (detail) IconButton(onClick = { detailId = null }) { AppGlyph(Glyph.Back, description = "返回任务列表") }
                        else Surface(modifier = Modifier.size(40.dp), shape = RoundedCornerShape(14.dp), color = Color.White,
                            border = BorderStroke(2.dp, Color.White), shadowElevation = 2.dp) {
                            Image(painter = painterResource(R.drawable.lolicode_avatar), contentDescription = null,
                                modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Crop)
                        }
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(if (detail) session?.title ?: "任务详情" else when (tab) {
                                CompanionTab.Workbench -> "LoliCode"
                                CompanionTab.Tasks -> "我的任务"
                                CompanionTab.Devices -> "我的设备"
                            }, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge,
                                color = if (detail) LoliColors.Ink else LoliColors.Violet)
                            Text(if (detail) state.computer?.name ?: "电脑端会话" else when (tab) {
                                CompanionTab.Workbench -> "灵感随行，工作继续"
                                CompanionTab.Tasks -> "与你的电脑，保持同一进度"
                                CompanionTab.Devices -> "你的私人远程工作空间"
                            }, style = MaterialTheme.typography.labelSmall, color = LoliColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        when {
                            detail -> IconButton(onClick = actions.refresh, enabled = state.usable && !state.busy) { AppGlyph(Glyph.Refresh, description = "刷新任务") }
                            tab == CompanionTab.Devices -> IconButton(onClick = { if (state.account == null) loginDialog = true else actions.discoverComputers() }, enabled = !state.accountBusy) { AppGlyph(Glyph.Refresh, tint = LoliColors.Rose, description = "刷新同账号电脑") }
                            tab == CompanionTab.Tasks -> IconButton(onClick = { startNewTask() }) { AppGlyph(Glyph.Plus, tint = LoliColors.Rose, description = "新建任务") }
                            else -> ComputerStatusPill(state)
                        }
                    }
                },
                bottomBar = {
                    Column {
                        if (detail && session != null) draftHolder.SaveableStateProvider("${state.selectedRoom}:${session.id}") {
                            TaskComposer(state, snapshot, actions, session.id)
                        }
                        if (!keyboardVisible) {
                            Surface(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                                shape = RoundedCornerShape(27.dp), color = Color.White.copy(alpha = 0.97f),
                                border = BorderStroke(1.dp, Color.White), shadowElevation = 5.dp) {
                            NavigationBar(containerColor = Color.Transparent, tonalElevation = 0.dp, windowInsets = WindowInsets(0, 0, 0, 0)) {
                                CompanionTab.entries.forEach { destination ->
                                    val (label, glyph, tag) = when (destination) {
                                        CompanionTab.Workbench -> Triple("工作台", Glyph.Workbench, "nav_workbench")
                                        CompanionTab.Tasks -> Triple("任务", Glyph.Tasks, "nav_tasks")
                                        CompanionTab.Devices -> Triple("设备", Glyph.Devices, "nav_devices")
                                    }
                                    NavigationBarItem(selected = tab == destination, onClick = { tab = destination; if (destination == CompanionTab.Tasks) detailId = null }, modifier = Modifier.testTag(tag),
                                        colors = NavigationBarItemDefaults.colors(selectedIconColor = LoliColors.Rose, selectedTextColor = LoliColors.Rose, indicatorColor = LoliColors.RoseSoft, unselectedTextColor = LoliColors.Muted),
                                        icon = { BadgedBox(badge = { if (destination == CompanionTab.Tasks && pending > 0) Badge(containerColor = LoliColors.Rose) { Text(pending.toString()) } }) {
                                            Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                                                AppGlyph(glyph, tint = if (tab == destination) LoliColors.Rose else LoliColors.Muted)
                                                if (tab == destination) AppGlyph(Glyph.Sparkle, modifier = Modifier.align(Alignment.TopEnd), tint = LoliColors.Violet, size = 6.dp)
                                            }
                                        } }, label = { Text(label, fontWeight = if (tab == destination) FontWeight.SemiBold else FontWeight.Normal) })
                                }
                            }
                            }
                        }
                    }
                },
            ) { padding ->
                Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                    if (state.busy || state.accountBusy || state.modelsLoading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = LoliColors.Rose, trackColor = LoliColors.RoseSoft)
                    state.error?.let { error ->
                        Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), shape = RoundedCornerShape(14.dp)) {
                            Row(Modifier.padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(error, modifier = Modifier.weight(1f).padding(vertical = 10.dp), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
                                IconButton(onClick = actions.clearError) { AppGlyph(Glyph.Close, description = "关闭错误提示") }
                            }
                        }
                    }
                    state.modelError?.let { error ->
                        Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), shape = RoundedCornerShape(14.dp)) {
                            Column(Modifier.padding(14.dp)) {
                                Text("模型目录加载失败：$error", color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = actions.refresh, enabled = state.usable && !state.busy && !state.modelsLoading) { Text("重新加载模型") }
                            }
                        }
                    }
                    when (tab) {
                        CompanionTab.Workbench -> WorkbenchScreen(state, onLogin = { loginDialog = true }, onHelp = { helpSheet = true }, onNewTask = { startNewTask() }, onDevices = { tab = CompanionTab.Devices }, onTasks = { tab = CompanionTab.Tasks; detailId = null }, onOpenSession = ::openSession)
                        CompanionTab.Tasks -> if (detail) TaskDetailScreen(state, snapshot, actions) else TaskListScreen(state, onNewTask = { startNewTask() }, onDevices = { tab = CompanionTab.Devices }, onOpenSession = ::openSession, onLoadMore = actions.loadMoreSessions)
                        CompanionTab.Devices -> DeviceScreen(state, actions, notificationsAllowed, onLogin = { loginDialog = true }, onForget = { forget = it }, onHelp = { helpSheet = true })
                    }
                }
            }
        }
        if (newTaskSheet) NewTaskSheet(state, actions, creatingSession, onDismiss = { if (!creatingSession) newTaskSheet = false }, onCreate = {
            previousSessionId = state.selectedSession; creatingSession = true; actions.createSession()
        })
        if (loginDialog) AccountLoginDialog(onDismiss = { loginDialog = false }, onLogin = actions.login)
        if (helpSheet) PairingHelpSheet { helpSheet = false }
        forget?.let { computer -> AlertDialog(onDismissRequest = { forget = null }, title = { Text("移除 ${computer.name}？") },
            text = { Text("将删除手机保存的连接凭据。若需要彻底撤销访问，请同时在电脑端撤销此配对。") },
            confirmButton = { TextButton(onClick = { actions.forgetComputer(computer.id); forget = null }) { Text("移除设备") } },
            dismissButton = { TextButton(onClick = { forget = null }) { Text("取消") } }) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewTaskSheet(state: CompanionState, actions: CompanionActions, creating: Boolean, onDismiss: () -> Unit, onCreate: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = LoliColors.Background) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            GlyphTile(Glyph.Sparkle)
            Text("开始一项新任务", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("选择电脑上的项目与模型，再写下你想完成的事。", style = MaterialTheme.typography.bodyMedium, color = LoliColors.Muted)
            LoliChoice("项目", state.projects.firstOrNull { it.path == state.selectedProject }?.name.orEmpty(), state.projects.map { it.path to it.name }, state.usable && !state.busy, actions.selectProject)
            if (state.projects.isEmpty()) Text("还没有可用项目，请先在电脑端打开项目，再刷新。", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
            if (state.modelsLoading) Text("正在同步完整模型目录…", color = LoliColors.Muted, style = MaterialTheme.typography.bodySmall)
            LoliChoice("模型", state.models.firstOrNull { it.id == state.selectedModel }?.name.orEmpty(), state.models.map { it.id to it.name }, state.usable && !state.busy && !state.modelsLoading && state.modelError == null, actions.selectModel)
            Button(onClick = onCreate, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp).testTag("create_session"), enabled = state.usable && !state.busy && !creating && !state.modelsLoading && state.modelError == null && state.selectedProject.isNotBlank() && state.selectedModel.isNotBlank(), shape = RoundedCornerShape(16.dp)) {
                if (creating) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp)) }
                Text(if (creating) "正在创建…" else "创建任务会话")
            }
            TextButton(onClick = actions.refresh, enabled = state.usable && !state.busy) { AppGlyph(Glyph.Refresh, size = 16.dp, tint = LoliColors.Rose); Spacer(Modifier.width(8.dp)); Text("刷新项目与模型") }
        }
    }
}

@Composable
internal fun LoliChoice(label: String, selected: String, choices: List<Pair<String, String>>, enabled: Boolean = true, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = LoliColors.Muted)
        Box(Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = { expanded = true }, enabled = enabled && choices.isNotEmpty(), modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp), shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, LoliColors.Line), contentPadding = PaddingValues(horizontal = 15.dp, vertical = 12.dp)) {
                Text(selected.ifBlank { "请选择$label" }, Modifier.weight(1f), color = if (enabled) LoliColors.Ink else LoliColors.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                AppGlyph(Glyph.Down, size = 18.dp)
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 320.dp)) {
                choices.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { expanded = false; onSelect(id) }) }
            }
        }
    }
}
