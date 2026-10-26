package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.Pairing

// Static, nonfunctional sample credentials. These previews never instantiate a
// ViewModel, CredentialStore, Firebase service or network client.
private val previewComputer = PairedComputer(
    Pairing("wss://example.invalid/companion", "0".repeat(32), "0".repeat(64), "A".repeat(43), "我的电脑", 0),
    deviceId = "preview-phone", approved = true,
)
private val previewSession = Session("lc:preview-session", "检查项目里的构建问题", "D:/projects/my-app")
private val pairedState = CompanionState(
    computers = listOf(previewComputer), selectedRoom = previewComputer.id,
    connection = "已安全连接 · 电脑静默后台执行", relayReady = true, desktopOnline = true, hostVerified = true,
    projects = listOf(Project(previewSession.projectPath, "my-app")), selectedProject = previewSession.projectPath,
    models = listOf(Model("preview-model", "开发模型")), selectedModel = "preview-model",
    sessions = listOf(previewSession), selectedSession = previewSession.id,
)

@Preview(name = "01 · 未配对", widthDp = 393, heightDp = 852, showBackground = true, locale = "zh")
@Preview(name = "01b · 360dp", widthDp = 360, heightDp = 800, showBackground = true, locale = "zh")
@Composable
private fun EmptyCompanionPreview() {
    CompanionScreen(CompanionState())
}

@Preview(name = "02 · 后台运行进度", widthDp = 393, heightDp = 852, showBackground = true, locale = "zh")
@Composable
private fun RunningCompanionPreview() {
    CompanionScreen(pairedState.copy(snapshot = SessionSnapshot(
        session = previewSession, status = "running",
        messages = listOf(ChatMessage("user", "检查一下这个项目的构建问题。"),
            ChatMessage("assistant", "正在检查项目文件和依赖配置，任务在电脑后台继续。")),
        approvals = emptyList(), questions = emptyList(), diffs = emptyList(),
        error = "", truncated = false, truncationMessage = "",
    )))
}

@Preview(name = "03 · 等待一次审批", widthDp = 393, heightDp = 852, showBackground = true, locale = "zh")
@Composable
private fun ApprovalCompanionPreview() {
    CompanionScreen(pairedState.copy(snapshot = SessionSnapshot(
        session = previewSession, status = "waiting_permission",
        messages = listOf(ChatMessage("assistant", "已定位配置问题，修改前需要你确认。")),
        approvals = listOf(Approval("preview-approval", "修改项目文件", "edit_file\nsrc/app.ts\n修复导入路径；不运行终端或接管桌面。")),
        questions = emptyList(), diffs = emptyList(), error = "", truncated = false, truncationMessage = "",
    )), initialTab = CompanionTab.Tasks, initialTaskDetail = true)
}

@Preview(name = "04 · 设备管理", widthDp = 393, heightDp = 852, showBackground = true, locale = "zh")
@Composable
private fun DevicesCompanionPreview() {
    CompanionScreen(pairedState, initialTab = CompanionTab.Devices)
}
