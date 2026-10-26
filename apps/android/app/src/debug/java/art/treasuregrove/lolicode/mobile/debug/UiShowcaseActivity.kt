package art.treasuregrove.lolicode.mobile.debug

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.Pairing
import art.treasuregrove.lolicode.mobile.ui.CompanionActions
import art.treasuregrove.lolicode.mobile.ui.CompanionScreen
import art.treasuregrove.lolicode.mobile.ui.CompanionTab

/**
 * An actual Compose Activity for debug emulator UI checks, isolated from the
 * production route. It never creates a ViewModel, transport, credential store,
 * Firebase client or permission request. Every action changes only sample state.
 *
 * Explicit adb examples after installing the debug APK:
 * adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario empty
 * adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario running
 * adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario approval
 * adb shell am start -n art.treasuregrove.lolicode.mobile/.debug.UiShowcaseActivity --es scenario completed
 * Add --es tab tasks --ez detail true to start in task detail, or --es tab devices
 * for the device tab. The real screen's bottom navigation remains interactive.
 *
 * This component is exported solely in src/debug, without an intent filter, so
 * adb can explicitly launch it. Extras select only these public sample states;
 * neither caller-provided credentials nor business commands are accepted.
 */
class UiShowcaseActivity : ComponentActivity() {
    private var launch by mutableStateOf(ShowcaseLaunch())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        launch = ShowcaseLaunch.from(intent)
        setContent {
            key(launch) {
                ShowcaseScreen(launch) { scenario ->
                    launch = ShowcaseLaunch(scenario = scenario)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        launch = ShowcaseLaunch.from(intent)
    }
}

private enum class ShowcaseScenario(val wire: String, val label: String) {
    Empty("empty", "未配对"),
    Running("running", "后台运行"),
    Approval("approval", "等待审批"),
    Completed("completed", "任务完成");

    val defaultTab: CompanionTab
        get() = if (this == Approval || this == Completed) CompanionTab.Tasks else CompanionTab.Workbench
    val defaultDetail: Boolean get() = this == Approval || this == Completed
}

private data class ShowcaseLaunch(
    val scenario: ShowcaseScenario = ShowcaseScenario.Empty,
    val tab: CompanionTab = scenario.defaultTab,
    val detail: Boolean = scenario.defaultDetail,
) {
    companion object {
        fun from(intent: Intent): ShowcaseLaunch {
            val scenario = ShowcaseScenario.entries.firstOrNull {
                it.wire == intent.getStringExtra("scenario")
            } ?: ShowcaseScenario.Empty
            val tab = when (intent.getStringExtra("tab")) {
                "workbench" -> CompanionTab.Workbench
                "tasks" -> CompanionTab.Tasks
                "devices" -> CompanionTab.Devices
                else -> scenario.defaultTab
            }
            return ShowcaseLaunch(
                scenario = scenario,
                tab = tab,
                detail = intent.getBooleanExtra("detail", scenario.defaultDetail),
            )
        }
    }
}

@Composable
private fun ShowcaseScreen(launch: ShowcaseLaunch, onScenario: (ShowcaseScenario) -> Unit) {
    var state by remember(launch) { mutableStateOf(sampleState(launch.scenario)) }
    var menuOpen by remember { mutableStateOf(false) }
    val actions = CompanionActions(
        pair = { state = sampleState(ShowcaseScenario.Running) },
        scan = { state = state.copy(error = "演示模式：不打开相机，不连接真实电脑。可从上方菜单切换演示场景。") },
        selectComputer = { id -> state = state.copy(selectedRoom = id) },
        forgetComputer = { state = sampleState(ShowcaseScenario.Empty) },
        reconnect = { state = state.copy(connection = "演示连接 · 电脑静默后台执行", error = null) },
        selectProject = { path -> state = state.copy(selectedProject = path) },
        selectModel = { id -> state = state.copy(selectedModel = id) },
        selectSession = { id -> state = state.copy(selectedSession = id) },
        createSession = {
            val session = Session("lc:showcase-new", "新的演示任务", sampleProject.path)
            state = state.copy(
                sessions = listOf(session) + state.sessions.filterNot { it.id == session.id },
                selectedSession = session.id,
                snapshot = sampleSnapshot(session, "idle", listOf(ChatMessage("assistant", "这是离线演示会话。输入只保留在当前画面，不会发送到电脑。"))),
            )
        },
        refresh = { state = state.copy(error = null) },
        clearError = { state = state.copy(error = null) },
        replyPermission = { _, allow ->
            state = state.copy(snapshot = state.snapshot?.copy(
                status = "idle", approvals = emptyList(),
                messages = state.snapshot.orEmptyMessages() + ChatMessage(
                    "assistant", if (allow) "演示：已选择允许一次。没有发送审批，也没有修改真实文件。" else "演示：已拒绝这次操作。没有发送审批或执行任务。",
                ),
            ))
        },
        replyQuestion = { _, _ -> state = state.copy(snapshot = state.snapshot?.copy(status = "idle", questions = emptyList())) },
        sendMessage = { text, onAccepted ->
            state = state.copy(snapshot = state.snapshot?.copy(
                status = "idle",
                messages = state.snapshot.orEmptyMessages() + listOf(
                    ChatMessage("user", text),
                    ChatMessage("assistant", "这是离线演示：任务没有发送到电脑。"),
                ),
            ))
            onAccepted()
        },
        cancel = {
            state = state.copy(snapshot = state.snapshot?.copy(
                status = "idle", approvals = emptyList(), questions = emptyList(),
                messages = state.snapshot.orEmptyMessages() + ChatMessage("assistant", "演示任务已停止，没有操作真实电脑。"),
            ))
        },
        requestNotifications = { state = state.copy(error = "演示模式不申请通知权限；系统锁屏推送仍未启用。") },
    )

    MaterialTheme {
        Column(Modifier.fillMaxSize().background(Color(0xFFFFF7FB))) {
            Surface(color = Color(0xFFFFE4EF), contentColor = Color(0xFF7C2346)) {
                Row(
                    Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars)
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Surface(color = Color(0xFF7C2346), contentColor = Color.White, shape = RoundedCornerShape(5.dp)) {
                        Text("演示数据", Modifier.padding(horizontal = 7.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                    }
                    Text("离线 · 不操作电脑", style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                    Box {
                        TextButton(onClick = { menuOpen = true }, contentPadding = PaddingValues(horizontal = 6.dp)) {
                            Text("${launch.scenario.label} ▾", color = Color(0xFF7C2346), style = MaterialTheme.typography.labelMedium)
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            ShowcaseScenario.entries.forEach { scenario ->
                                DropdownMenuItem(text = { Text(scenario.label) }, onClick = { menuOpen = false; onScenario(scenario) })
                            }
                        }
                    }
                }
            }
            Box(Modifier.weight(1f)) {
                CompanionScreen(
                    state = state,
                    actions = actions,
                    notificationsAllowed = false,
                    initialTab = launch.tab,
                    initialTaskDetail = launch.detail,
                )
            }
        }
    }
}

// Deliberately unusable sample credentials. This Activity constructs no client
// and never passes these values to the real pairing/import route.
private val sampleComputer = PairedComputer(
    Pairing("wss://example.invalid/companion", "0".repeat(32), "0".repeat(64), "A".repeat(43), "我的开发电脑", 0),
    deviceId = "offline-showcase-phone", approved = true,
)
private val sampleProject = Project("D:/Projects/lolicode-demo", "LoliCode Demo")
private val sampleSession = Session("lc:showcase-session", "完善登录页的交互文案", sampleProject.path)
private val sampleDiff = FileDiff(
    "src/features/login/LoginPanel.tsx",
    "@@ -18,1 +18,1 @@\n-  <Button>继续</Button>\n+  <Button>登录并继续</Button>",
)

private fun sampleState(scenario: ShowcaseScenario): CompanionState {
    if (scenario == ShowcaseScenario.Empty) return CompanionState()
    val userMessage = ChatMessage("user", "把登录页按钮的文案改得更清楚，并说明修改内容。")
    val snapshot = when (scenario) {
        ShowcaseScenario.Running -> sampleSnapshot(sampleSession, "running", listOf(
            userMessage,
            ChatMessage("assistant", "已读取登录页组件，正在检查按钮与提示文案。任务在电脑后台进行，你可以继续使用电脑。"),
        ))
        ShowcaseScenario.Approval -> sampleSnapshot(sampleSession, "waiting_permission", listOf(
            userMessage,
            ChatMessage("assistant", "已找到登录按钮。准备将“继续”调整为“登录并继续”，修改前需要你确认。"),
        )).copy(approvals = listOf(Approval(
            "showcase-approval", "修改项目文件", "write_file\nsrc/features/login/LoginPanel.tsx\n将按钮“继续”改为“登录并继续”。仅修改这一处文案，不执行终端命令。",
        )))
        ShowcaseScenario.Completed -> sampleSnapshot(sampleSession, "idle", listOf(
            userMessage,
            ChatMessage("assistant", "已将登录按钮改为“登录并继续”。\n\n修改了 1 个文件，点击下方差异可查看。当前后台模式未运行终端或测试命令。"),
        )).copy(diffs = listOf(sampleDiff))
        ShowcaseScenario.Empty -> error("The unpaired sample has no session")
    }
    return CompanionState(
        computers = listOf(sampleComputer), selectedRoom = sampleComputer.id,
        connection = "已安全连接 · 电脑静默后台执行",
        relayReady = true, desktopOnline = true, hostVerified = true,
        projects = listOf(sampleProject), selectedProject = sampleProject.path,
        models = listOf(Model("showcase-model", "开发模型")), selectedModel = "showcase-model",
        sessions = listOf(sampleSession), selectedSession = sampleSession.id,
        snapshot = snapshot,
    )
}

private fun sampleSnapshot(session: Session, status: String, messages: List<ChatMessage>) = SessionSnapshot(
    session = session, status = status, messages = messages,
    approvals = emptyList(), questions = emptyList(), diffs = emptyList(),
    error = "", truncated = false, truncationMessage = "",
)

private fun SessionSnapshot?.orEmptyMessages(): List<ChatMessage> = this?.messages.orEmpty()
