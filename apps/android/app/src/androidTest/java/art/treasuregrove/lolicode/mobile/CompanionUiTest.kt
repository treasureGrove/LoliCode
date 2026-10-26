package art.treasuregrove.lolicode.mobile

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import art.treasuregrove.lolicode.mobile.ui.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Native UI interactions only; no transport, model calls or saved credentials. */
@RunWith(AndroidJUnit4::class)
class CompanionUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun firstLaunchUsesAccountLoginAndHasNoLegacyPairingEntry() {
        var pairs = 0
        compose.setContent { CompanionScreen(CompanionState(), CompanionActions(pair = { pairs++ })) }
        compose.onNodeWithTag("account_login").assertIsDisplayed()
        compose.onNodeWithText("粘贴配对码").assertDoesNotExist()
        compose.onNodeWithTag("legacy_pairing").assertDoesNotExist()
        compose.onNodeWithTag("pair_scan").assertDoesNotExist()
        compose.onNodeWithTag("pair_paste").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, pairs) }
        compose.onNodeWithTag("nav_tasks").performClick().assertIsSelected()
        compose.onNodeWithTag("nav_devices").performClick().assertIsSelected()
        compose.onNodeWithTag("legacy_pairing").assertDoesNotExist()
        compose.onNodeWithTag("pair_scan").assertDoesNotExist()
        compose.onNodeWithTag("pair_paste").assertDoesNotExist()
        compose.onNodeWithTag("nav_workbench").performClick().assertIsSelected()
    }

    @Test fun directStatusRequiresTheActualTransportAndDisplaysSetupFailure() {
        val state = mutableStateOf(paired("idle").copy(transport = null))
        compose.setContent { CompanionScreen(state.value) }
        // Saved approval and account/desktop readiness cannot claim a direct route.
        compose.onAllNodesWithText("在线 · 未直连").onFirst().assertIsDisplayed()
        compose.onNodeWithText("在线 · 已直连").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(transport = "direct") }
        compose.onAllNodesWithText("在线 · 已直连").onFirst().assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(transport = null, relayReady = false, connection = "直连不可用，请切换网络后重试") }
        compose.onAllNodesWithText("在线 · 未直连").onFirst().assertIsDisplayed()
        compose.onNodeWithText("直连不可用，请切换网络后重试").performScrollTo().assertIsDisplayed()
    }

    @Test fun expiredOrFailedDirectoryNeverLeavesCachedDevicesGreenOrCallsThemOffline() {
        val state = mutableStateOf(paired("idle").copy(transport = null, relayReady = false, desktopOnline = false))
        compose.setContent { CompanionScreen(state.value, initialTab = CompanionTab.Devices) }
        compose.onAllNodesWithText("在线 · 未直连").onFirst().assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(presenceNowElapsedMs = 61_000) }
        compose.onAllNodesWithText("状态待确认 · 未直连").onFirst().assertIsDisplayed()
        compose.onNodeWithText("在线 · 未直连").assertDoesNotExist()
        compose.onNodeWithText("离线 · 未直连").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(directoryFreshness = state.value.directoryFreshness.copy(valid = false)) }
        compose.onAllNodesWithText("状态待确认 · 未直连").onFirst().assertIsDisplayed()
        compose.onNodeWithTag("nav_workbench").performClick()
        compose.onAllNodesWithText("状态待确认 · 未直连").onFirst().assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(directoryFreshness = DirectoryFreshness("42", 61_001, true), presenceNowElapsedMs = 61_001) }
        compose.onAllNodesWithText("在线 · 未直连").onFirst().assertIsDisplayed()
    }

    @Test fun loginUsesTheEnteredPasswordOnceAndDoesNotRestoreIt() {
        val submitted = mutableListOf<Pair<String, String>>()
        compose.setContent { CompanionScreen(CompanionState(), CompanionActions(login = { id, password -> submitted += id to password })) }
        compose.onNodeWithTag("account_login").performClick()
        compose.onNodeWithTag("account_login_submit").assertIsNotEnabled()
        compose.onNodeWithTag("account_identification").performTextInput("fixture-user")
        compose.onNodeWithTag("account_password").performTextInput("fictional-test-password")
        compose.onNodeWithTag("account_login_submit").performClick()
        compose.runOnIdle { assertEquals(listOf("fixture-user" to "fictional-test-password"), submitted) }
        compose.onNodeWithTag("account_password").assertDoesNotExist()
        compose.onNodeWithTag("account_login").performClick()
        compose.onNodeWithTag("account_password").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithTag("account_password").performTextInput("discard-on-cancel")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithTag("account_login").performClick()
        compose.onNodeWithTag("account_password").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    }

    @Test fun discoveredComputerRequiresARequestAndShowsPendingDesktopApproval() {
        val desktop = AccountDevice("00000000-0000-4000-8000-000000000010", "测试账号电脑", "desktop", "public-fixture", "a".repeat(64), true, 1)
        val phone = AccountDevice("00000000-0000-4000-8000-000000000011", "测试手机", "phone", "phone-public-fixture", "b".repeat(64), true, 1)
        val state = mutableStateOf(CompanionState(account = AccountProfile("42", "fixture", "界面测试账号"), discoveredComputers = listOf(desktop)))
        val requests = mutableListOf<String>()
        var discoveries = 0
        var logouts = 0
        compose.setContent { CompanionScreen(state.value, CompanionActions(requestConnection = { requests += it }, discoverComputers = { discoveries++ }, logout = { logouts++ }), initialTab = CompanionTab.Devices) }
        compose.onNodeWithTag("account_discover").performClick()
        compose.runOnIdle { assertEquals(1, discoveries); assertEquals(emptyList<String>(), requests) }
        compose.onNodeWithTag("connect_${desktop.deviceId}").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf(desktop.deviceId), requests)
            state.value = state.value.copy(enrollment = EnrollmentRequest("fixture-request", "42", "A".repeat(43), desktop, phone, 1, 300001, "pending", null, null))
        }
        compose.onNodeWithTag("connect_${desktop.deviceId}").assertIsNotEnabled()
        compose.onNodeWithTag("account_logout").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, logouts) }
    }

    @Test fun changingIdentityDiscardsThePreviousAccountsDraft() {
        val original = paired("idle").copy(account = AccountProfile("42", "first", "账号一"))
        val state = mutableStateOf(original)
        compose.setContent { CompanionScreen(state.value, initialTab = CompanionTab.Tasks, initialTaskDetail = true) }
        compose.onNodeWithTag("task_composer").performTextInput("不应交给另一个账号的草稿")
        compose.runOnIdle { state.value = CompanionState(account = AccountProfile("43", "second", "账号二"), identityEpoch = 1) }
        compose.onNodeWithTag("task_composer").assertDoesNotExist()
        compose.runOnIdle { state.value = original.copy(identityEpoch = 2) }
        compose.onNodeWithTag("task_composer").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    }

    @Test fun approvalNeedsActualDirectAndVerifiedHostEvenWhenDirectoryIsOnline() {
        val state = mutableStateOf(paired("waiting_permission").copy(transport = null))
        val replies = mutableListOf<Pair<String, Boolean>>()
        compose.setContent {
            CompanionScreen(state.value, CompanionActions(replyPermission = { id, allow -> replies += id to allow }),
                initialTab = CompanionTab.Tasks, initialTaskDetail = true)
        }
        compose.onNodeWithTag("approval_allow_approval-1").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("approval_reject_approval-1").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(emptyList<Pair<String, Boolean>>(), replies) }
        compose.runOnIdle { state.value = state.value.copy(transport = "direct", hostVerified = false) }
        compose.onNodeWithTag("approval_allow_approval-1").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(hostVerified = true) }
        compose.onNodeWithTag("approval_allow_approval-1").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("approval-1" to true), replies) }
    }

    @Test fun rejectionUsesTheCurrentApprovalAndNeverGrantsAccess() {
        val replies = mutableListOf<Pair<String, Boolean>>()
        compose.setContent {
            CompanionScreen(paired("waiting_permission"), CompanionActions(replyPermission = { id, allow -> replies += id to allow }),
                initialTab = CompanionTab.Tasks, initialTaskDetail = true)
        }
        compose.onNodeWithTag("approval_reject_approval-1").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("approval-1" to false), replies) }
    }

    @Test fun sendingRetainsTheDraftUntilTheComputerAcceptsIt() {
        var sent: String? = null
        var accepted: (() -> Unit)? = null
        compose.setContent {
            CompanionScreen(paired("idle"), CompanionActions(sendMessage = { text, callback -> sent = text; accepted = callback }),
                initialTab = CompanionTab.Tasks, initialTaskDetail = true)
        }
        compose.onNodeWithTag("task_composer").performTextInput("检查项目的配置")
        compose.onNodeWithTag("send_task").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("检查项目的配置", sent); assertNotNull(accepted) }
        compose.onNodeWithTag("task_composer").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("检查项目的配置")))
        compose.runOnIdle { accepted!!.invoke() }
        compose.onNodeWithTag("task_composer").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    }

    @Test fun switchingTabsDoesNotDiscardAnUnsentDraft() {
        val state = paired("idle")
        compose.setContent {
            CompanionScreen(state, initialTab = CompanionTab.Tasks, initialTaskDetail = true)
        }
        compose.onNodeWithTag("task_composer").performTextInput("稍后继续的任务草稿")
        Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("nav_devices").performClick().assertIsSelected()
        compose.onNodeWithTag("nav_tasks").performClick().assertIsSelected()
        val row = "task_${state.selectedSession}"
        if (compose.onAllNodesWithTag(row).fetchSemanticsNodes().isNotEmpty()) {
            compose.onNodeWithTag(row).performClick()
        }
        compose.onNodeWithTag("task_composer").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("稍后继续的任务草稿")))
    }

    @Test fun acceptanceWhileAnotherTabIsVisibleClearsTheSavedDraft() {
        val state = paired("idle")
        var sent: String? = null
        var accepted: (() -> Unit)? = null
        compose.setContent {
            CompanionScreen(
                state,
                CompanionActions(sendMessage = { text, callback -> sent = text; accepted = callback }),
                initialTab = CompanionTab.Tasks,
                initialTaskDetail = true,
            )
        }
        compose.onNodeWithTag("task_composer").performTextInput("只发送一次的任务")
        compose.onNodeWithTag("send_task").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("只发送一次的任务", sent); assertNotNull(accepted) }
        Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("nav_devices").performClick().assertIsSelected()
        compose.onNodeWithTag("task_composer").assertDoesNotExist()

        // The desktop accepts only after the detail/composer leaves composition.
        // Clearing a detached composer's local state must not leave a stale copy
        // in the navigation draft store that the user could accidentally resend.
        compose.runOnIdle { accepted!!.invoke() }
        compose.onNodeWithTag("nav_tasks").performClick().assertIsSelected()
        compose.onNodeWithTag("task_${state.selectedSession}").performClick()
        compose.onNodeWithTag("task_composer").assert(
            SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")),
        )
    }

    private fun paired(status: String): CompanionState {
        val identity = DeviceIdentity.generate()
        val device = AccountDevice("00000000-0000-4000-8000-000000000010", "测试电脑", "desktop", identity.publicKeySpki, identity.fingerprint, true, 1)
        val computer = PairedComputer(Pairing("wss://example.invalid/companion", "0".repeat(32), "0".repeat(64), "A".repeat(43), "测试电脑", 0), "ui-test-phone", true, "42", device.deviceId, device.fingerprint)
        val session = Session("lc:00000000-0000-4000-8000-000000000001", "检查项目配置", "D:/ui-test-project")
        return CompanionState(
            account = AccountProfile("42", "fixture", "界面测试账号"), discoveredComputers = listOf(device),
            directoryFreshness = DirectoryFreshness("42", 1_000, true), presenceNowElapsedMs = 1_000,
            computers = listOf(computer), selectedRoom = computer.id,
            connection = "UI测试连接", transport = "direct", relayReady = true, desktopOnline = true, hostVerified = true,
            projects = listOf(Project(session.projectPath, "ui-test-project")), selectedProject = session.projectPath,
            models = listOf(Model("ui-test-model", "测试模型")), selectedModel = "ui-test-model",
            sessions = listOf(session), selectedSession = session.id,
            snapshot = SessionSnapshot(session, status, emptyList(),
                if (status == "waiting_permission") listOf(Approval("approval-1", "修改配置文件", "只修改项目内的文件。")) else emptyList(),
                emptyList(), emptyList(), "", false, ""),
        )
    }
}
