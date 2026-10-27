package art.treasuregrove.lolicode.mobile

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.espresso.IdlingPolicies
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleCallback
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import art.treasuregrove.lolicode.mobile.data.Session
import art.treasuregrove.lolicode.mobile.protocol.validDeviceId
import art.treasuregrove.lolicode.mobile.protocol.wireJson
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import org.junit.AssumptionViolatedException
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import org.junit.runners.model.Statement

/** Opt-in, read-only clicks through the real Activity, account, ViewModel and transport. */
@RunWith(AndroidJUnit4::class)
class RealAccountUiSmokeTest {
    // Construct inside the observed rule, after the explicit opt-in/unlocked guard.
    private val compose by lazy { createEmptyComposeRule() }
    private var phase = Phase.GUARD
    private var lifecycleStep = LifecycleStep.NONE
    private var model: CompanionViewModel? = null
    private var endAt = 0L

    // This wraps Compose setup AND teardown: its ordinary assertion errors can contain
    // the entire real semantic tree. Never let one escape into the JUnit result.
    private val privacy = TestRule { base, _ ->
        object : Statement() {
            override fun evaluate() {
                try {
                    base.evaluate()
                } catch (_: AssumptionViolatedException) {
                    runCatching { report("blocked", Code.OPT_IN_OR_UNLOCK_REQUIRED) }
                    throw AssumptionViolatedException("REAL_UI_SMOKE_BLOCKED")
                } catch (failure: Throwable) {
                    val code = (failure as? SafeFailure)?.code ?: Code.UI_OR_SYSTEM_FAILURE
                    runCatching { report("failed", code) }
                    throw AssertionError("REAL_UI_SMOKE_FAILED phase=${phase.name} code=${code.name}")
                }
            }
        }
    }

    private val observedCompose = TestRule { base, description ->
        object : Statement() {
            override fun evaluate() {
                assumeTrue(InstrumentationRegistry.getArguments().getString("realAccountUiSmoke") == "1")
                enterLifecycle(LifecycleStep.RULE_ENTER)
                requireSafe(BuildConfig.DEBUG, Code.DEBUG_REQUIRED)
                val keyguard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(KeyguardManager::class.java)
                assumeTrue(!keyguard.isDeviceLocked && !keyguard.isKeyguardLocked)
                val master = IdlingPolicies.getMasterIdlingPolicy()
                val resource = IdlingPolicies.getDynamicIdlingResourceErrorPolicy()
                try {
                    IdlingPolicies.setMasterPolicyTimeout(30, TimeUnit.SECONDS)
                    IdlingPolicies.setIdlingResourceTimeout(45, TimeUnit.SECONDS)
                    enterLifecycle(LifecycleStep.ESPRESSO_POLICY_READY)
                    enterLifecycle(LifecycleStep.COMPOSE_RULE_CONSTRUCT_BEFORE)
                    val rule = compose
                    enterLifecycle(LifecycleStep.COMPOSE_RULE_CONSTRUCT_AFTER)
                    val body = object : Statement() {
                        override fun evaluate() {
                            enterLifecycle(LifecycleStep.BODY_ENTER)
                            try { base.evaluate() }
                            finally { enterLifecycle(LifecycleStep.BODY_EXIT) }
                        }
                    }
                    enterLifecycle(LifecycleStep.COMPOSE_EVALUATE_BEFORE)
                    try { rule.apply(body, description).evaluate() }
                    finally { enterLifecycle(LifecycleStep.COMPOSE_EVALUATE_AFTER) }
                } finally {
                    // These process-local policies belong only to this opted-in test.
                    // Neither policy can interrupt every waitForIdleSync; the runner
                    // owner's external wall-clock bound remains necessary.
                    IdlingPolicies.setMasterPolicyTimeout(master.idleTimeout, master.idleTimeoutUnit)
                    IdlingPolicies.setIdlingResourceTimeout(resource.idleTimeout, resource.idleTimeoutUnit)
                    enterLifecycle(LifecycleStep.RULE_EXIT)
                }
            }
        }
    }

    @get:Rule val rules: TestRule = RuleChain.outerRule(privacy).around(observedCompose)

    @Test fun readsExistingReplyReconnectsAndSelectsModelThroughRealUi() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("realAccountUiSmoke") == "1")
        requireSafe(BuildConfig.DEBUG, Code.DEBUG_REQUIRED)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        // No Activity is launched, no keyguard dismissal is requested, and no input is
        // injected if the user has not already unlocked this device.
        assumeTrue(!keyguard.isDeviceLocked && !keyguard.isKeyguardLocked)
        enterPhase(Phase.CONTROL)
        val control = readControl(File(context.filesDir, "companion-real-ui-control.json"))
        report("control_read_and_deleted")
        endAt = SystemClock.elapsedRealtime() + 600_000
        val monitor = ActivityLifecycleMonitorRegistry.getInstance()
        val ownedActivity = AtomicReference<MainActivity?>(null)
        val resumed = AtomicBoolean(false)
        val destroyed = AtomicBoolean(false)
        val launchIssued = AtomicBoolean(false)
        var callbackRegistered = false
        val activityObserver = ActivityLifecycleCallback { activity, stage ->
            if (launchIssued.get() && activity is MainActivity && activity.packageName == context.packageName) {
                if (stage == Stage.PRE_ON_CREATE || stage == Stage.CREATED) ownedActivity.compareAndSet(null, activity)
                if (activity === ownedActivity.get()) {
                    if (stage == Stage.RESUMED) resumed.set(true)
                    if (stage == Stage.DESTROYED) destroyed.set(true)
                    // Observe only fixed lifecycle metadata. Reporting cannot alter
                    // Activity callbacks or leak an exception from the main thread.
                    runCatching { report("activity_lifecycle", extra = { putString("activityStage", stage.name) }) }
                }
            }
        }
        try {
            enterPhase(Phase.ACTIVITY)
            instrumentation.runOnMainSync {
                runCatching { monitor.addLifecycleCallback(activityObserver) }.onSuccess { callbackRegistered = true }
            }
            requireSafe(callbackRegistered, Code.ACTIVITY_OBSERVER_UNAVAILABLE)
            enterLifecycle(LifecycleStep.LAUNCH_BEFORE)
            launchIssued.set(true)
            context.startActivity(Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            enterLifecycle(LifecycleStep.LAUNCH_AFTER)
            waitForLifecycle(45_000, Code.ACTIVITY_NOT_RESUMED) { resumed.get() }
            enterLifecycle(LifecycleStep.ON_ACTIVITY_BEFORE)
            instrumentation.runOnMainSync {
                // Never throw a test assertion from the app's main thread.
                runCatching {
                    val activity = monitor.getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<MainActivity>()
                        .singleOrNull { it.packageName == context.packageName && it === ownedActivity.get() }
                    if (activity != null) {
                        // Same default key/store as MainActivity's `by viewModels()`.
                        model = ViewModelProvider(activity)[CompanionViewModel::class.java]
                    }
                }
            }
            enterLifecycle(LifecycleStep.ON_ACTIVITY_AFTER)
            val vm = model ?: throw SafeFailure(Code.ACTIVITY_MODEL_MISSING)
            checkIdentity(vm.state.value, control)
            val computer = vm.state.value.computers.singleOrNull {
                it.accountId == vm.state.value.account?.id && it.approved &&
                    it.desktopDeviceId == control.desktopDeviceId && it.desktopFingerprint == control.desktopFingerprint
            } ?: throw SafeFailure(Code.SAVED_DESKTOP_MISSING)
            requireSafe(vm.state.value.computers.count { it.name == computer.name } == 1, Code.AMBIGUOUS_DESKTOP_LABEL)

            enterPhase(Phase.DEVICES)
            enterLifecycle(LifecycleStep.FIRST_CLICK_BEFORE)
            clickTag("nav_devices")
            enterLifecycle(LifecycleStep.FIRST_CLICK_AFTER)
            waitState(control, 60_000) { !it.accountBusy }
            clickTag("account_discover", scroll = true)
            waitState(control, 60_000) {
                !it.accountBusy && it.directoryFreshness.valid && it.discoveredComputers.any { row ->
                    row.deviceId == control.desktopDeviceId && row.fingerprint == control.desktopFingerprint
                }
            }
            val wasSelected = vm.state.value.selectedRoom == computer.id
            clickInList(hasClickAction() and hasAnyDescendant(hasText(computer.name)))
            enterPhase(Phase.CONNECTED)
            waitReady(control)
            report("real_device_ui_ready", extra = { putBoolean("savedDesktopAlreadySelected", wasSelected) })

            enterPhase(Phase.DIRECTORY)
            clickTag("nav_tasks")
            val target = findTargetThroughUi(control)
            clickInList(hasTestTag("task_${target.id}"))
            waitState(control, 90_000) { !it.busy && it.selectedSession == target.id && it.snapshot?.session?.id == target.id }
            requireNoUiErrors()
            enterPhase(Phase.EXISTING_REPLY)
            verifyRenderedReply(control, target)
            report("real_existing_reply_displayed")

            enterPhase(Phase.RECONNECT)
            clickTag("nav_devices")
            waitState(control, 40_000) { !it.busy }
            observeState({ !it.usable }) { sawDisconnected ->
                clickInList(buttonWithText("重新连接"))
                waitState(control, 150_000) {
                    sawDisconnected.get() && it.usable && !it.busy && !it.modelsLoading && it.models.isNotEmpty()
                }
                requireSafe(sawDisconnected.get(), Code.RECONNECT_NOT_OBSERVED)
            }
            requireNoUiErrors()
            enterPhase(Phase.RECONNECTED_REPLY)
            clickTag("nav_tasks")
            val restored = findTargetThroughUi(control)
            requireSafe(restored.id == target.id, Code.TARGET_CHANGED)
            clickInList(hasTestTag("task_${restored.id}"))
            waitState(control, 90_000) { !it.busy && it.selectedSession == target.id && it.snapshot?.session?.id == target.id }

            // Clicking the same selected row intentionally does not selectSession
            // again. The production refresh action performs refreshAll's actual
            // session.attach + session.get, including a legitimate notModified read.
            // Equal StateFlow values may retain their reference; reference inequality
            // is therefore not a freshness assertion.
            observeState({ it.busy }) { sawBusy ->
                compose.onNodeWithContentDescription("刷新任务").assertIsEnabled().performClick()
                waitState(control, 120_000) { sawBusy.get() && !it.busy && it.usable && it.snapshot?.session?.id == target.id }
                requireSafe(sawBusy.get(), Code.FRESH_READ_NOT_OBSERVED)
            }
            requireNoUiErrors()
            verifyRenderedReply(control, target)
            report("real_ui_reconnect_and_fresh_read_verified", extra = { putBoolean("freshReadViaUiRefresh", true) })

            enterPhase(Phase.MODEL_CHOICE)
            clickTag("nav_tasks")
            waitReady(control)
            val current = vm.state.value.models.singleOrNull { it.id == vm.state.value.selectedModel }
                ?: throw SafeFailure(Code.MODEL_SELECTION_MISSING)
            val choices = vm.state.value.models
            requireSafe(choices.size == control.expectedModelCount, Code.MODEL_COUNT)
            val chosen = choices.firstOrNull { candidate -> candidate.id != current.id && choices.count { it.name == candidate.name } == 1 }
                ?: choices.singleOrNull() ?: throw SafeFailure(Code.AMBIGUOUS_MODEL_LABEL)
            compose.onNodeWithContentDescription("新建任务").performClick()
            compose.onNodeWithTag("create_session").assertExists()
            compose.onNode(
                buttonWithText(current.name) and hasAnyAncestor(isDialog()),
                useUnmergedTree = true,
            ).performScrollTo().assertIsEnabled().performClick()
            compose.onNode(
                hasClickAction() and hasAnyDescendant(hasText(chosen.name)) and hasAnyAncestor(isPopup()),
                useUnmergedTree = true,
            ).performScrollTo().performClick()
            waitState(control, 10_000) { it.selectedModel == chosen.id }
            requireSafe(vm.state.value.selectedSession == target.id, Code.TARGET_CHANGED)
            // Never click create_session, send_task, an approval, logout, or removal.
            report("real_ui_smoke_complete", extra = {
                putInt("modelCount", choices.size)
                putBoolean("modelSelectionChanged", chosen.id != current.id)
                putBoolean("createdSession", false)
                putBoolean("sentMessage", false)
                putBoolean("credentialValuesLogged", false)
            })
        } finally {
            // MainActivity.onStop/onCleared own normal connection cleanup. Preserve
            // the account, pairing, existing session and application preferences.
            enterLifecycle(LifecycleStep.CLOSE_BEFORE)
            try {
                ownedActivity.get()?.let { activity ->
                    if (!destroyed.get()) {
                        val finishIssued = AtomicBoolean(false)
                        instrumentation.runOnMainSync { runCatching { activity.finish() }.onSuccess { finishIssued.set(true) } }
                        requireSafe(finishIssued.get(), Code.ACTIVITY_CLEANUP_FAILED)
                    }
                    waitForLifecycle(20_000, Code.ACTIVITY_CLEANUP_FAILED) { destroyed.get() }
                }
                enterLifecycle(LifecycleStep.CLOSE_AFTER)
            } catch (_: Throwable) {
                throw SafeFailure(Code.ACTIVITY_CLEANUP_FAILED)
            } finally {
                if (callbackRegistered) {
                    val removed = AtomicBoolean(false)
                    instrumentation.runOnMainSync { runCatching { monitor.removeLifecycleCallback(activityObserver) }.onSuccess { removed.set(true) } }
                    requireSafe(removed.get(), Code.ACTIVITY_CLEANUP_FAILED)
                }
            }
        }
    }

    /** Real lifecycle observation, independent of Compose/Instrumentation idle waits. */
    private fun waitForLifecycle(timeout: Long, code: Code, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (!predicate()) {
            requireSafe(SystemClock.elapsedRealtime() < deadline, code)
            val keyguard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(KeyguardManager::class.java)
            requireSafe(!keyguard.isDeviceLocked && !keyguard.isKeyguardLocked, Code.DEVICE_LOCKED_DURING_TEST)
            SystemClock.sleep(25)
        }
    }

    private fun findTargetThroughUi(control: Control): Session {
        var pages = 1
        while (true) {
            val state = waitState(control, 60_000) { !it.busy && it.usable && it.sessions.isNotEmpty() }
            if (state.sessionsNextOffset == null) {
                requireSafe(state.sessions.size == state.sessionsTotal, Code.DIRECTORY_INCOMPLETE)
                report("real_session_directory_displayed", extra = { putInt("directoryPages", pages); putInt("sessionCount", state.sessions.size) })
                return state.sessions.singleOrNull { sha256("session-id|${it.id}") == control.targetSessionIdHash }
                    ?: throw SafeFailure(Code.TARGET_NOT_FOUND)
            }
            requireSafe(pages < 96 && state.sessions.size < 500, Code.DIRECTORY_BUDGET)
            val previousOffset = state.sessionsNextOffset
            observeState({ it.busy }) { sawBusy ->
                clickTag("load_more_sessions", scroll = true)
                waitState(control, 60_000) { sawBusy.get() && !it.busy }
            }
            requireNoUiErrors()
            requireSafe(model!!.state.value.sessionsNextOffset != previousOffset, Code.DIRECTORY_NO_PROGRESS)
            pages++
        }
    }

    private fun verifyRenderedReply(control: Control, target: Session) {
        val vm = model!!
        var pages = 0
        while (vm.state.value.snapshot?.messages?.none {
                it.role == "assistant" && !it.textTruncated && sha256(it.body) == control.expectedAssistantTextSha256
            } != false) {
            val snapshot = vm.state.value.snapshot ?: throw SafeFailure(Code.SNAPSHOT_MISSING)
            requireSafe(snapshot.session.id == target.id, Code.TARGET_CHANGED)
            requireSafe(snapshot.nextHistoryOffset != null && pages < 32, Code.EXPECTED_REPLY_NOT_FOUND)
            val previousOffset = snapshot.nextHistoryOffset
            observeState({ it.busy }) { sawBusy ->
                compose.onNodeWithTag("task_detail").performScrollToNode(hasTestTag("load_older_history"))
                clickTag("load_older_history")
                waitState(control, 60_000) { sawBusy.get() && !it.busy }
            }
            requireNoUiErrors()
            requireSafe(vm.state.value.snapshot?.nextHistoryOffset != previousOffset, Code.HISTORY_NO_PROGRESS)
            pages++
        }
        val expectedText = SemanticsMatcher("the authorized assistant reply UTF-8 hash") { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.any { sha256(it.text) == control.expectedAssistantTextSha256 } == true
        }
        compose.onNodeWithTag("task_detail").performScrollToNode(expectedText)
        compose.onAllNodes(expectedText, useUnmergedTree = true).onFirst().assertIsDisplayed()
        requireSafe(vm.state.value.selectedSession == target.id && vm.state.value.snapshot?.session?.id == target.id, Code.TARGET_CHANGED)
    }

    private fun waitReady(control: Control) {
        waitState(control, 150_000) {
            it.usable && !it.busy && !it.modelsLoading && it.models.size == control.expectedModelCount &&
                it.computer?.desktopDeviceId == control.desktopDeviceId && it.computer?.desktopFingerprint == control.desktopFingerprint
        }
        requireNoUiErrors()
    }

    private fun waitState(control: Control, timeout: Long, predicate: (CompanionState) -> Boolean): CompanionState {
        val remaining = endAt - SystemClock.elapsedRealtime()
        requireSafe(remaining > 0, Code.TOTAL_DEADLINE)
        compose.waitUntil(timeoutMillis = minOf(timeout, remaining)) {
            val keyguard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(KeyguardManager::class.java)
            requireSafe(!keyguard.isDeviceLocked && !keyguard.isKeyguardLocked, Code.DEVICE_LOCKED_DURING_TEST)
            val state = model!!.state.value
            checkIdentity(state, control)
            predicate(state)
        }
        return model!!.state.value
    }

    /** Observe UI-triggered async work without calling a ViewModel action in its place. */
    private fun observeState(predicate: (CompanionState) -> Boolean, block: (AtomicBoolean) -> Unit) {
        val seen = AtomicBoolean(false)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            scope.launch(start = CoroutineStart.UNDISPATCHED) { model!!.state.collect { if (predicate(it)) seen.set(true) } }
        }
        try { block(seen) }
        finally { scope.cancel() }
    }

    private fun clickTag(tag: String, scroll: Boolean = false) {
        if (scroll) compose.onNode(hasScrollToIndexAction(), useUnmergedTree = true).performScrollToNode(hasTestTag(tag))
        compose.onNodeWithTag(tag).assertIsEnabled().performClick()
    }

    private fun clickInList(matcher: SemanticsMatcher) {
        compose.onNode(hasScrollToIndexAction(), useUnmergedTree = true).performScrollToNode(matcher)
        compose.onNode(matcher, useUnmergedTree = true).assertIsEnabled().performClick()
    }

    private fun buttonWithText(text: String) = hasClickAction() and
        SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button) and hasAnyDescendant(hasText(text))

    private fun checkIdentity(state: CompanionState, control: Control) {
        val account = state.account ?: throw SafeFailure(Code.LOGIN_REQUIRED)
        requireSafe(sha256("lolicode-auth-status-v1|${account.id}") == control.accountHash, Code.ACCOUNT_SCOPE)
    }

    private fun requireNoUiErrors() {
        val state = model!!.state.value
        requireSafe(state.error == null && state.modelError == null, Code.UI_ERROR_PRESENT)
    }

    private fun readControl(file: File): Control {
        requireSafe(file.parentFile?.canonicalFile == InstrumentationRegistry.getInstrumentation().targetContext.filesDir.canonicalFile &&
            !Files.isSymbolicLink(file.toPath()) && file.canonicalFile.parentFile == file.parentFile?.canonicalFile &&
            file.isFile && file.length() in 1..8192, Code.CONTROL_UNAVAILABLE)
        val raw = try {
            file.inputStream().use { input ->
                val buffer = ByteArray(8193)
                var count = 0
                while (count < buffer.size) {
                    val read = input.read(buffer, count, buffer.size - count)
                    if (read < 0) break
                    count += read
                }
                requireSafe(count in 1..8192, Code.CONTROL_INVALID)
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(buffer, 0, count)).toString()
            }
        } finally { requireSafe(file.delete(), Code.CONTROL_CLEANUP_FAILED) }
        val value = wireJson.parseToJsonElement(raw).jsonObject
        val fields = setOf("v", "runId", "accountHash", "desktopDeviceId", "desktopFingerprint", "targetSessionIdHash", "expectedAssistantTextSha256", "expectedModelCount")
        requireSafe(value.keys == fields && value["v"] == JsonPrimitive(1), Code.CONTROL_INVALID)
        fun string(key: String): String {
            val item = value[key] as? JsonPrimitive ?: throw SafeFailure(Code.CONTROL_INVALID)
            requireSafe(item.isString, Code.CONTROL_INVALID)
            return item.content
        }
        val runId = string("runId")
        val accountHash = string("accountHash")
        val deviceId = string("desktopDeviceId")
        val fingerprint = string("desktopFingerprint")
        val target = string("targetSessionIdHash")
        val reply = string("expectedAssistantTextSha256")
        val count = (value["expectedModelCount"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
            ?: throw SafeFailure(Code.CONTROL_INVALID)
        requireSafe(runId.matches(Regex("[A-Za-z0-9_-]{6,64}")) && validDeviceId(deviceId) && count in 1..20_000 &&
            listOf(accountHash, fingerprint, target, reply).all { it.matches(Regex("[0-9a-f]{64}")) }, Code.CONTROL_INVALID)
        return Control(accountHash, deviceId, fingerprint, target, reply, count)
    }

    private fun report(result: String, code: Code? = null, extra: Bundle.() -> Unit = {}) {
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString("realUiPhase", phase.name)
            putString("realUiLifecycle", lifecycleStep.name)
            putString("realUiResult", result)
            code?.let { putString("fixedCode", it.name) }
            model?.state?.value?.let { state ->
                putString("activeTransport", state.transport?.takeIf { it in setOf("text", "direct") } ?: "none")
                putBoolean("usable", state.usable)
                putInt("loadedSessions", state.sessions.size)
                putString("connectionReasonCode", state.connectionReasonCode?.name ?: "none")
                putStringArrayList("connectionReasonHistory", ArrayList(state.connectionReasonHistory.map { it.name }))
            }
            extra()
        })
    }

    private fun enterPhase(next: Phase) { phase = next; report("phase_entry") }
    private fun enterLifecycle(next: LifecycleStep) { lifecycleStep = next; report("lifecycle_entry") }

    private fun requireSafe(condition: Boolean, code: Code) { if (!condition) throw SafeFailure(code) }
    private fun sha256(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private class SafeFailure(val code: Code) : RuntimeException()
    private data class Control(val accountHash: String, val desktopDeviceId: String, val desktopFingerprint: String,
        val targetSessionIdHash: String, val expectedAssistantTextSha256: String, val expectedModelCount: Int)
    private enum class Phase { GUARD, CONTROL, ACTIVITY, DEVICES, CONNECTED, DIRECTORY, EXISTING_REPLY, RECONNECT, RECONNECTED_REPLY, MODEL_CHOICE }
    private enum class LifecycleStep {
        NONE, RULE_ENTER, ESPRESSO_POLICY_READY, COMPOSE_RULE_CONSTRUCT_BEFORE, COMPOSE_RULE_CONSTRUCT_AFTER,
        COMPOSE_EVALUATE_BEFORE, BODY_ENTER, LAUNCH_BEFORE, LAUNCH_AFTER, ON_ACTIVITY_BEFORE, ON_ACTIVITY_AFTER,
        FIRST_CLICK_BEFORE, FIRST_CLICK_AFTER, CLOSE_BEFORE, CLOSE_AFTER, BODY_EXIT, COMPOSE_EVALUATE_AFTER, RULE_EXIT,
    }
    private enum class Code {
        OPT_IN_OR_UNLOCK_REQUIRED, DEBUG_REQUIRED, CONTROL_UNAVAILABLE, CONTROL_INVALID, CONTROL_CLEANUP_FAILED,
        LOGIN_REQUIRED, ACCOUNT_SCOPE, SAVED_DESKTOP_MISSING, AMBIGUOUS_DESKTOP_LABEL, ACTIVITY_MODEL_MISSING,
        ACTIVITY_NOT_RESUMED, ACTIVITY_OBSERVER_UNAVAILABLE,
        DIRECTORY_INCOMPLETE, DIRECTORY_BUDGET, DIRECTORY_NO_PROGRESS, TARGET_NOT_FOUND, TARGET_CHANGED,
        SNAPSHOT_MISSING, EXPECTED_REPLY_NOT_FOUND, HISTORY_NO_PROGRESS, RECONNECT_NOT_OBSERVED, FRESH_READ_NOT_OBSERVED,
        MODEL_COUNT, MODEL_SELECTION_MISSING, AMBIGUOUS_MODEL_LABEL, UI_ERROR_PRESENT, TOTAL_DEADLINE,
        DEVICE_LOCKED_DURING_TEST, ACTIVITY_CLEANUP_FAILED, UI_OR_SYSTEM_FAILURE,
    }
}
