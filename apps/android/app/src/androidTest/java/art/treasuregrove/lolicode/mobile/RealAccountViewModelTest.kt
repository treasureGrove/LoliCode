package art.treasuregrove.lolicode.mobile

import android.app.Application
import android.os.Bundle
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit user-authorized real-account acceptance. Credentials remain behind the real App/ViewModel APIs. */
@RunWith(AndroidJUnit4::class)
class RealAccountViewModelTest {
    @Test fun exercisesRealAccountViewModelWithUserApprovedControl() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("realAccountAcceptance") == "1")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val store = ViewModelStore()
        var model: CompanionViewModel? = null
        var phase = "control"
        fun report(name: String, extra: Bundle.() -> Unit = {}) {
            phase = name
            instrumentation.sendStatus(0, Bundle().apply { putString("realAccountPhase", name); extra() })
        }
        fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
        try {
            withTimeout(420_000) {
                val file = File(instrumentation.targetContext.filesDir, "companion-real-account-control.json")
                check(file.isFile && file.length() in 1..16_384) { "RA_CONTROL_UNAVAILABLE" }
                val control = try { wireJson.parseToJsonElement(file.readText(Charsets.UTF_8)).jsonObject }
                finally { check(file.delete()) { "RA_CONTROL_CLEANUP" } }
                check(control.keys.all { it in setOf("v", "runId", "phase", "accountHash", "desktopDeviceId", "desktopFingerprint", "existingSessionId", "projectPath", "expectedSnapshotRevision", "existingModelId", "existingMessageId", "expectedExistingTextSha256", "expectedModelCount", "targetSessionIdHash", "expectedAssistantTextSha256") }) { "RA_CONTROL_FIELDS" }
                check(control.string("phase") in setOf("catalogue", "task", "resume") && control.string("runId").matches(Regex("[A-Za-z0-9_-]{6,40}"))) { "RA_CONTROL_PHASE" }
                check(control.string("accountHash").matches(Regex("[0-9a-f]{64}")) && validDeviceId(control.string("desktopDeviceId")) && control.string("desktopFingerprint").matches(Regex("[0-9a-f]{64}"))) { "RA_CONTROL_IDENTITY" }
                main { model = CompanionViewModel(instrumentation.targetContext.applicationContext as Application); store.put("owned-real-account-acceptance", model!!) }
                val vm = model!!
                val account = vm.state.value.account ?: error("RA_LOGIN_REQUIRED")
                check(hash("lolicode-auth-status-v1|${account.id}") == control.string("accountHash")) { "RA_ACCOUNT_SCOPE" }
                val desktopId = control.string("desktopDeviceId")
                val desktopFingerprint = control.string("desktopFingerprint")
                val saved = vm.state.value.computers.firstOrNull { it.desktopDeviceId == desktopId && it.desktopFingerprint == desktopFingerprint && it.approved }
                check(saved != null || vm.state.value.computers.isEmpty()) { "RA_DESKTOP_SELECTION" }
                if (saved != null) main { vm.selectComputer(saved.id) }
                report("normal_account_discovery")
                main { vm.foreground() }
                suspend fun state(seconds: Long = 120, predicate: (CompanionState) -> Boolean): CompanionState = withTimeout(seconds * 1000) { vm.state.first(predicate) }
                state(60) { it.directoryFreshness.valid && it.discoveredComputers.any { d -> d.deviceId == desktopId && d.fingerprint == desktopFingerprint } }
                if (saved == null) {
                    report("normal_connection_request")
                    main { vm.requestConnection(desktopId) }
                    val requested = state(60) { it.enrollment != null }
                    report("awaiting_exact_desktop_approval") { putString("requestId", requested.enrollment!!.requestId) }
                    state(120) { it.computers.any { c -> c.desktopDeviceId == desktopId && c.desktopFingerprint == desktopFingerprint && c.approved } }
                }
                report("waiting_real_app_transport")
                val connected = state(150) { it.usable && it.computer?.desktopDeviceId == desktopId && it.computer?.desktopFingerprint == desktopFingerprint }
                report("real_app_transport_ready") { putString("transport", connected.transport); putString("accountHash", control.string("accountHash")) }
                state(90) { it.sessions.isNotEmpty() }
                suspend fun action(block: () -> Job) {
                    state(40) { !it.busy }
                    lateinit var job: Job
                    main { vm.clearError(); job = block() }
                    job.join()
                    check(vm.state.value.error == null) { "RA_NORMAL_ACTION" }
                }
                var directoryPages = 1
                report("directory_initial_state") {
                    putInt("directoryPages", directoryPages); putInt("nextOffset", vm.state.value.sessionsNextOffset ?: -1)
                    putInt("loadedSessions", vm.state.value.sessions.size); putInt("totalSessions", vm.state.value.sessionsTotal)
                    vm.state.value.error?.let { putString("vmErrorSha256", hash(it)); putString("errorCategory", errorCategory(it)) }
                }
                while (vm.state.value.sessionsNextOffset != null && directoryPages < 16) {
                    val previous = vm.state.value.sessionsNextOffset
                    report("directory_page_request") {
                        putInt("directoryPages", directoryPages + 1); putInt("requestedOffset", previous!!)
                        putInt("loadedSessions", vm.state.value.sessions.size); putInt("totalSessions", vm.state.value.sessionsTotal)
                    }
                    action { vm.loadMoreSessions() }
                    report("directory_page_response") {
                        putInt("directoryPages", directoryPages + 1); putInt("nextOffset", vm.state.value.sessionsNextOffset ?: -1)
                        putInt("loadedSessions", vm.state.value.sessions.size); putInt("totalSessions", vm.state.value.sessionsTotal)
                    }
                    check(vm.state.value.sessionsNextOffset != previous) { "RA_DIRECTORY_NO_PROGRESS" }
                    directoryPages++
                }
                report("waiting_complete_model_catalogue")
                state(90) { !it.modelsLoading }
                check(vm.state.value.modelError == null) { "RA_MODEL_INITIALIZATION" }
                val catalogue = vm.state.value
                (control["expectedModelCount"] as? JsonPrimitive)?.intOrNull?.let { check(catalogue.models.size == it) { "RA_MODEL_COUNT" } }
                report("real_catalogue_ready") {
                    putInt("directoryPages", directoryPages); putInt("visibleSessionCount", catalogue.sessions.size); putInt("totalSessionCount", catalogue.sessionsTotal)
                    putInt("loadedModelCount", catalogue.models.size)
                    putString("sessionMetadataHashes", buildJsonArray {
                        catalogue.sessions.take(96).forEach { row -> add(buildJsonObject {
                            put("sessionIdHash", hash("session-id|${row.id}")); put("titleHash", hash("session-title|${row.title}")); put("projectHash", hash("project-path|${row.projectPath}"))
                        }) }
                    }.toString())
                }
                if (control.string("phase") == "resume") {
                    val targetHash = control.string("targetSessionIdHash")
                    val expectedReplyHash = control.string("expectedAssistantTextSha256")
                    check(targetHash.matches(Regex("[0-9a-f]{64}")) && expectedReplyHash.matches(Regex("[0-9a-f]{64}"))) { "RA_RESUME_HASH_CONTROL" }
                    val target = catalogue.sessions.firstOrNull { hash("session-id|${it.id}") == targetHash } ?: error("RA_RESUME_TARGET_MISSING")
                    report("readonly_resume_select_existing")
                    action { vm.selectSession(target.id) }
                    fun matchingReply(): ChatMessage? = vm.state.value.snapshot?.takeIf { it.session.id == target.id }?.messages?.firstOrNull { it.role == "assistant" && hash(it.body) == expectedReplyHash }
                    check(matchingReply() != null) { "RA_RESUME_REPLY_MISSING" }
                    report("readonly_resume_reply_verified") { putString("replySha256", expectedReplyHash); putInt("replyBytes", matchingReply()!!.body.toByteArray(Charsets.UTF_8).size) }
                    report("readonly_resume_reconnect")
                    main { vm.reconnect() }
                    state(150) { it.usable && it.selectedSession == target.id }
                    action { vm.selectSession(target.id) }
                    check(matchingReply() != null) { "RA_RESUME_RESTORED_REPLY" }
                    report("readonly_resume_and_reconnect_verified") {
                        putString("targetSessionIdHash", targetHash); putString("replySha256", expectedReplyHash)
                        putBoolean("createdOrSentMutation", false)
                        putString("connectionReasonHistory", vm.state.value.connectionReasonHistory.joinToString(",") { it.name })
                    }
                }
                val existingId = control.string("existingSessionId")
                if (existingId.isNotBlank()) {
                    report("explicit_existing_session_selection")
                    check(catalogue.sessions.any { it.id == existingId }) { "RA_EXISTING_DIRECTORY" }
                    action { vm.selectSession(existingId) }
                    val snapshot = vm.state.value.snapshot ?: error("RA_EXISTING_SNAPSHOT")
                    check(snapshot.session.id == existingId) { "RA_EXISTING_SESSION_ID" }
                    report("real_existing_session_attached") { putString("selectedSessionIdHash", hash("session-id|$existingId")) }
                    val expected = if (control.string("expectedExistingTextSha256").isNotBlank()) control else if (control.string("phase") == "task") {
                        // Desktop computes hashes only after the phone's explicit attach. This non-secret update contains no task body or credentials.
                        val expectedFile = File(instrumentation.targetContext.filesDir, "companion-real-account-expected.json")
                        report("waiting_desktop_existing_text_hash")
                        withTimeout(90_000) { while (!expectedFile.isFile) delay(250) }
                        check(expectedFile.length() in 1..16_384) { "RA_EXPECTED_SIZE" }
                        val value = try { wireJson.parseToJsonElement(expectedFile.readText(Charsets.UTF_8)).jsonObject }
                        finally { check(expectedFile.delete()) { "RA_EXPECTED_CLEANUP" } }
                        check(value.string("existingSessionId") == existingId && value.string("runId") == control.string("runId")) { "RA_EXPECTED_SELECTION" }
                        value
                    } else control
                    expected.string("expectedSnapshotRevision").takeIf { it.isNotBlank() }?.let { check(snapshot.revision == it) { "RA_SNAPSHOT_REVISION" } }
                    val messageId = expected.string("existingMessageId")
                    check(control.string("phase") != "task" || messageId.isNotBlank()) { "RA_EXPECTED_MESSAGE_REQUIRED" }
                    if (messageId.isNotBlank()) {
                        var historyPages = 1
                        while (vm.state.value.snapshot!!.messages.none { it.id == messageId } && vm.state.value.snapshot!!.nextHistoryOffset != null && historyPages < 32) {
                            action { vm.loadOlderHistory() }; historyPages++
                        }
                        check(vm.state.value.snapshot!!.messages.any { it.id == messageId }) { "RA_MESSAGE_NOT_FOUND" }
                        var messagePages = 0
                        do {
                            action { vm.loadMessageText(messageId) }; messagePages++
                            val text = vm.state.value.snapshot!!.messages.single { it.id == messageId }
                            check(text.loadedBytes <= 128 * 1024 && messagePages <= 96) { "RA_READ_BUDGET" }
                        } while (vm.state.value.snapshot!!.messages.single { it.id == messageId }.textTruncated)
                        val text = vm.state.value.snapshot!!.messages.single { it.id == messageId }
                        check(hash(text.body) == expected.string("expectedExistingTextSha256")) { "RA_EXISTING_TEXT_HASH" }
                        report("real_existing_text_verified") { putInt("historyPages", historyPages); putInt("messagePages", messagePages); putInt("textBytes", text.loadedBytes); putString("textSha256", hash(text.body)) }
                    }
                }
                if (control.string("phase") == "task") {
                    report("select_registered_project_and_model")
                    val projectPath = control.string("projectPath")
                    val modelId = control.string("existingModelId")
                    check(vm.state.value.projects.any { it.path == projectPath }) { "RA_PROJECT_NOT_REGISTERED" }
                    action { vm.selectProject(projectPath) }
                    check(vm.state.value.models.any { it.id == modelId }) { "RA_MODEL_UNAVAILABLE" }
                    main { vm.selectModel(modelId) }
                    report("create_independent_real_acceptance_session")
                    action { vm.createSession() } // Exactly once. A failure is not retried.
                    val created = vm.state.value.selectedSession ?: error("RA_CREATED_SESSION_MISSING")
                    check(created != existingId) { "RA_CREATED_OVERWRITES_EXISTING" }
                    report("real_acceptance_session_created") { putString("createdSessionIdHash", hash("session-id|$created")) }
                    val runId = control.string("runId")
                    val expectedReply = "手机真实验收通过-$runId"
                    val accepted = AtomicBoolean(false)
                    report("send_single_minimal_real_ai_prompt")
                    action { vm.sendMessage("【真实验收 $runId】不要调用任何工具。请仅回复：$expectedReply") { accepted.set(true) } }
                    check(accepted.get()) { "RA_PROMPT_NOT_CONFIRMED" }
                    report("waiting_real_ai_output")
                    val result = state(150) { current ->
                        val latest = current.snapshot?.takeIf { it.session.id == created }
                        check(latest?.status !in setOf("error", "waiting_permission", "waiting_question")) { "RA_AI_REQUIRES_FOLLOWUP" }
                        latest?.status == "idle" && latest.messages.any { it.role == "assistant" && it.body.contains(expectedReply) }
                    }
                    val reply = result.snapshot!!.messages.last { it.role == "assistant" && it.body.contains(expectedReply) }
                    report("real_ai_output_verified") { putString("replySha256", hash(reply.body)); putInt("replyBytes", reply.body.toByteArray(Charsets.UTF_8).size) }
                    report("reconnect_same_real_app_session")
                    main { vm.reconnect() }
                    state(150) { it.usable && it.selectedSession == created }
                    // An explicit same-session selection forces a fresh attach/get after reconnection, rather than merely trusting cached UI text.
                    action { vm.selectSession(created) }
                    val restored = vm.state.value.snapshot ?: error("RA_RESTORED_SNAPSHOT_MISSING")
                    check(restored.session.id == created && restored.messages.any { it.role == "assistant" && it.body.contains(expectedReply) }) { "RA_RESTORED_TEXT_MISSING" }
                    report("real_task_and_reconnect_verified") { putString("createdSessionIdHash", hash("session-id|$created")); putBoolean("mutationRetried", false) }
                }
                report("real_account_acceptance_complete") { putString("mode", control.string("phase")); putBoolean("normalViewModelAndAccountRelay", true); putBoolean("credentialValuesLogged", false) }
            }
        } catch (failure: Exception) {
            // Never attach a raw network/JSON/keystore exception or task body to JUnit diagnostics.
            instrumentation.sendStatus(0, Bundle().apply {
                putString("failedPhase", phase)
                putString("failureClass", failure.javaClass.simpleName)
                putString("fixedFailureCode", failure.message?.takeIf { it in fixedReasons } ?: "RA_BUSINESS_OR_SYSTEM_EXCEPTION")
                model?.state?.value?.let { state ->
                    state.error?.let { putString("vmErrorSha256", hash(it)); putString("errorCategory", errorCategory(it)) }
                    state.modelError?.let { putString("modelErrorSha256", hash(it)); putString("modelErrorCategory", errorCategory(it)) }
                    putBoolean("vmBusy", state.busy)
                    putString("activeTransport", state.transport?.takeIf { it in setOf("text", "direct") } ?: "none")
                    putInt("loadedSessions", state.sessions.size); putInt("totalSessions", state.sessionsTotal)
                    putInt("nextOffset", state.sessionsNextOffset ?: -1)
                    putString("connectionReasonCode", state.connectionReasonCode?.name ?: "none")
                    putString("connectionReasonHistory", state.connectionReasonHistory.joinToString(",") { it.name })
                    putString("connectionUiSha256", hash(state.connection))
                    putBoolean("relayReady", state.relayReady); putBoolean("desktopOnline", state.desktopOnline); putBoolean("hostVerified", state.hostVerified)
                }
            })
            throw AssertionError("real account acceptance failed at $phase: ${failure.message?.takeIf { it in fixedReasons } ?: "RA_BUSINESS_OR_SYSTEM_EXCEPTION"} (${failure.javaClass.simpleName})")
        } finally {
            main { model?.background(); store.clear() }
        }
        Unit
    }

    private val fixedReasons = setOf(
        "RA_ACCOUNT_SCOPE",
        "RA_AI_REQUIRES_FOLLOWUP",
        "RA_CONTROL_CLEANUP",
        "RA_CONTROL_FIELDS",
        "RA_CONTROL_IDENTITY",
        "RA_CONTROL_PHASE",
        "RA_CONTROL_UNAVAILABLE",
        "RA_CREATED_OVERWRITES_EXISTING",
        "RA_CREATED_SESSION_MISSING",
        "RA_DESKTOP_SELECTION",
        "RA_DIRECTORY_NO_PROGRESS",
        "RA_EXISTING_DIRECTORY",
        "RA_EXISTING_SESSION_ID",
        "RA_EXISTING_SNAPSHOT",
        "RA_EXISTING_TEXT_HASH",
        "RA_EXPECTED_CLEANUP",
        "RA_EXPECTED_MESSAGE_REQUIRED",
        "RA_EXPECTED_SELECTION",
        "RA_EXPECTED_SIZE",
        "RA_LOGIN_REQUIRED",
        "RA_MESSAGE_NOT_FOUND",
        "RA_MODEL_UNAVAILABLE",
        "RA_MODEL_INITIALIZATION",
        "RA_MODEL_COUNT",
        "RA_NORMAL_ACTION",
        "RA_PROJECT_NOT_REGISTERED",
        "RA_PROMPT_NOT_CONFIRMED",
        "RA_READ_BUDGET",
        "RA_RESTORED_SNAPSHOT_MISSING",
        "RA_RESTORED_TEXT_MISSING",
        "RA_RESUME_HASH_CONTROL",
        "RA_RESUME_TARGET_MISSING",
        "RA_RESUME_REPLY_MISSING",
        "RA_RESUME_RESTORED_REPLY",
        "RA_SNAPSHOT_REVISION",
    )

    private fun errorCategory(message: String): String = when (message) {
        "内容超过文本中继范围，请直连查看完整内容；未执行任何审批",
        "此会话元数据超出文本页预算，请在电脑端缩短标题或项目路径后重试",
        "审批、提问或会话元数据超出文本预算，请直连查看；待处理项未被省略或处理",
        "受限文本消息过大，请缩短输入或使用直连",
        "受限文本参数过大，请缩短输入或使用直连" -> "known_budget"
        "电脑会话目录已更新，请刷新后重新翻页",
        "电脑会话目录顺序已更新，请刷新后重新翻页",
        "电脑返回的会话目录页位置无效",
        "会话目录分页无效",
        "会话目录增量基线已失效" -> "pagination_change"
        "文本通道繁忙，请稍后重试" -> "normal_transport_busy"
        "连接已变化，尚未发送的操作已取消",
        "连接已变化，请重新同步会话",
        "请等待电脑建立加密通道并完成授权",
        "请等待电脑上线并完成配对",
        "连接尚未就绪",
        "文本通道已变化，请重新确认任务状态" -> "connection_scope"
        else -> "other"
    }

    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
