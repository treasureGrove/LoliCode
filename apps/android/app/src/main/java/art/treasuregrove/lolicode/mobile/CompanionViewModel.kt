package art.treasuregrove.lolicode.mobile

import android.app.Application
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

data class CompanionState(
    val account: AccountProfile? = null, val discoveredComputers: List<AccountDevice> = emptyList(),
    val enrollment: EnrollmentRequest? = null, val accountBusy: Boolean = false, val identityEpoch: Int = 0,
    val transport: String? = null,
    val directoryFreshness: DirectoryFreshness = DirectoryFreshness(), val presenceNowElapsedMs: Long = 0,
    val computers: List<PairedComputer> = emptyList(), val selectedRoom: String? = null,
    val connection: String = "添加电脑，开始远程任务", val relayReady: Boolean = false, val desktopOnline: Boolean = false,
    val hostVerified: Boolean = false,
    val projects: List<Project> = emptyList(), val selectedProject: String = "",
    val models: List<Model> = emptyList(), val selectedModel: String = "",
    val sessions: List<Session> = emptyList(), val selectedSession: String? = null,
    val snapshot: SessionSnapshot? = null, val busy: Boolean = false, val error: String? = null,
    val pushConfigured: Boolean = false, val pushRegistered: Boolean = false,
    val pushError: String? = null,
) {
    val computer get() = computers.firstOrNull { it.id == selectedRoom }
    // desktopOnline is room-peer availability, not directory heartbeat presence.
    val usable get() = transport in setOf("direct", "text") && relayReady && desktopOnline && hostVerified && computer?.approved == true
    val selectedPresence get() = computer?.let(::presence) ?: DevicePresence.Unknown
    fun presence(device: AccountDevice): DevicePresence {
        if (device.kind != "desktop" || !directoryFreshness.isFreshFor(account?.id, presenceNowElapsedMs)) return DevicePresence.Unknown
        val canonical = discoveredComputers.firstOrNull { it.kind == "desktop" && it.deviceId == device.deviceId && it.publicKey == device.publicKey && it.fingerprint == device.fingerprint }
            ?: return DevicePresence.Unknown
        return if (canonical.online) DevicePresence.Online else DevicePresence.Offline
    }
    fun presence(computer: PairedComputer): DevicePresence {
        if (account == null || computer.accountId != account.id) return DevicePresence.Unknown
        val device = discoveredComputers.firstOrNull { it.deviceId == computer.desktopDeviceId && it.fingerprint == computer.desktopFingerprint }
            ?: return DevicePresence.Unknown
        return presence(device)
    }
}

class CompanionViewModel(application: Application) : AndroidViewModel(application) {
    private val store = CredentialStore(application)
    private val mutable = MutableStateFlow(CompanionState())
    val state = mutable.asStateFlow()
    private var client: RemoteClient? = null
    private var visible = false
    private var generation = 0
    private var retry: Job? = null
    private var poll: Job? = null
    private var retries = 0
    private var notificationSession: String? = null
    private val accountRelay = AccountRelay()
    private val ticketLock = Mutex()
    private var credential: ForumCredential? = null
    private var identity: StoredIdentity? = null
    private var ticket: DeviceSession? = null
    private var accountJob: Job? = null
    private var accountPoll: Job? = null
    private var connectionJob: Job? = null
    private var ticketRenewal: Job? = null
    private var identityEpoch = 0
    private var enrollmentVisible = false
    private var lastPresenceAt: Long? = null
    private var lastDevicesAt: Long? = null
    private var presenceExpiry: Job? = null
    private var directoryGeneration = 0
    private var eventRefresh: Job? = null
    private var lastSnapshotAt = 0L
    private val snapshotLock = Mutex()
    private var textRevision: Pair<String, String>? = null
    private val seenEvents = linkedSetOf<String>()

    init {
        runCatching {
            credential = store.activeCredential()
            identity = credential?.let { store.accountIdentity(it.account.id) }
            credential?.let { store.computers(it.account.id) } ?: emptyList()
        }.onSuccess { computers ->
            mutable.update { it.copy(account = credential?.account, computers = computers, selectedRoom = computers.firstOrNull()?.id) }
        }.onFailure { mutable.update { it.copy(error = "无法读取安全凭据。请在系统设置清除应用数据后重新配对。") } }
    }

    fun foreground() {
        if (visible) return
        visible = true
        invalidateDirectory()
        connect()
        startAccountPolling()
        if (BuildConfig.PUSH_CONFIGURED) {
            runCatching { FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    runCatching { store.savePushToken(task.result) }
                    if (visible && mutable.value.computer?.approved == true) client?.registerPush(task.result)
                } else mutable.update { it.copy(pushError = "未能获取 FCM 令牌，请检查 Google 服务及网络") }
            } }.onFailure { mutable.update { it.copy(pushError = "Firebase 初始化失败，请检查应用配置") } }
        }
    }

    fun background() {
        visible = false
        invalidateDirectory()
        accountPoll?.cancel(); accountPoll = null
        accountJob?.cancel(); accountJob = null
        disconnect()
        mutable.update { it.copy(relayReady = false, desktopOnline = false, hostVerified = false, transport = null, connection = "前台连接已暂停；电脑任务继续执行") }
    }

    fun pair(raw: String) {
        runCatching {
            require(credential == null) { "旧版配对独立保存，请先退出账号再使用兼容入口" }
            val pairing = Pairing.parse(raw.trim(), allowLocal = BuildConfig.ALLOW_LOCAL_RELAY)
            require(store.computers().none { it.id == pairing.roomId }) { "此电脑已保存，请直接选择；需重新配对时在电脑生成新码" }
            val computer = PairedComputer(pairing, store.deviceId())
            store.upsert(computer)
            mutable.update { CompanionState(computers = store.computers(), selectedRoom = computer.id) }
            connect()
        }.onFailure { error(it.message ?: "无法识别配对码") }
    }

    fun selectComputer(id: String) {
        if (id == mutable.value.selectedRoom) return
        if (mutable.value.computers.none { it.id == id }) return
        notificationSession = null
        mutable.update { accountState(it).copy(computers = it.computers, selectedRoom = id) }
        connect()
    }

    fun forgetComputer(id: String) = accountOperation {
        require(mutable.value.computers.any { it.id == id }) { "电脑不属于当前账号" }
        val accountId = credential?.account?.id
        if (accountId != null) withContext(Dispatchers.IO) { accountRelay.revokeRoom(ensureTicket(), id) }
        runCatching { store.remove(id, accountId) }.onSuccess {
            val remaining = store.computers(accountId)
            mutable.update { accountState(it).copy(computers = remaining, selectedRoom = remaining.firstOrNull()?.id) }
            connect()
        }.onFailure { error("无法移除保存的设备") }
    }

    fun reconnect() { retries = 0; ticket = null; connect(); startAccountPolling() }
    fun clearError() { mutable.update { it.copy(error = null) } }

    fun login(identification: String, password: String) {
        accountOperation {
            require(credential == null) { "请先退出当前账号" }
            val expected = identityEpoch
            val authenticated = withContext(Dispatchers.IO) { ForumIdentity().login(identification, password) }
            check(identityEpoch == expected) { "账号已切换" }
            disconnect(); accountPoll?.cancel()
            store.saveAccount(authenticated)
            val registered = store.accountIdentity(authenticated.account.id)
            credential = authenticated; identity = registered; ticket = null; lastPresenceAt = null; lastDevicesAt = null
            notificationSession = null; identityEpoch++
            val computers = store.computers(authenticated.account.id)
            mutable.value = CompanionState(account = authenticated.account, identityEpoch = identityEpoch,
                computers = computers, selectedRoom = computers.firstOrNull()?.id, connection = "正在发现同账号电脑…")
            connect(); startAccountPolling()
        }
    }

    fun logout() {
        identityEpoch++
        accountJob?.cancel(); accountJob = null; accountPoll?.cancel(); accountPoll = null
        presenceExpiry?.cancel(); presenceExpiry = null
        disconnect(); credential = null; identity = null; ticket = null; notificationSession = null
        val failure = runCatching { store.logoutAccount() }.exceptionOrNull()
        mutable.value = CompanionState(identityEpoch = identityEpoch,
            connection = "已退出账号，连接已关闭", error = failure?.let { "无法清除保存的账号，请在系统设置清除应用数据" })
    }

    fun discoverComputers() { accountOperation { refreshAccount(recover = true) } }
    fun enrollmentVisibility(visible: Boolean) {
        if (enrollmentVisible == visible) return
        enrollmentVisible = visible
        if (visible) startAccountPolling()
    }
    fun requestConnection(desktopId: String) {
        accountOperation {
            val expected = identityEpoch
            val account = credential?.account ?: throw IllegalStateException("请先登录 LoliCode")
            val local = identity ?: throw IllegalStateException("设备身份未就绪")
            val desktop = mutable.value.discoveredComputers.firstOrNull { it.deviceId == desktopId } ?: throw IllegalStateException("电脑不属于当前账号，请刷新设备列表")
            checkPeerPin(desktop)
            val request = withContext(Dispatchers.IO) { accountRelay.request(ensureTicket(), desktopId) }
            ensureAccount(expected, account.id)
            verifyRequest(request, desktop, account.id, local)
            mutable.update { it.copy(enrollment = request) }
            consumeEnrollment(request)
            startAccountPolling()
        }
    }

    private fun accountState(current: CompanionState) = CompanionState(account = current.account,
        discoveredComputers = current.discoveredComputers, enrollment = current.enrollment,
        accountBusy = current.accountBusy, identityEpoch = current.identityEpoch,
        directoryFreshness = current.directoryFreshness, presenceNowElapsedMs = current.presenceNowElapsedMs)

    private fun invalidateDirectory() {
        directoryGeneration++
        presenceExpiry?.cancel(); presenceExpiry = null
        mutable.update { it.copy(directoryFreshness = it.directoryFreshness.copy(valid = false), presenceNowElapsedMs = SystemClock.elapsedRealtime()) }
    }

    private fun publishDirectory(accountId: String, devices: List<AccountDevice>) {
        val observed = SystemClock.elapsedRealtime()
        val expected = identityEpoch
        mutable.update { it.copy(discoveredComputers = devices,
            directoryFreshness = DirectoryFreshness(accountId, observed, valid = true), presenceNowElapsedMs = observed) }
        presenceExpiry?.cancel()
        presenceExpiry = viewModelScope.launch {
            delay(DirectoryFreshness.MAX_AGE_MS)
            if (identityEpoch == expected && mutable.value.directoryFreshness.fetchedAtElapsedMs == observed) {
                mutable.update { it.copy(directoryFreshness = it.directoryFreshness.copy(valid = false), presenceNowElapsedMs = SystemClock.elapsedRealtime()) }
            }
        }
    }

    private fun ensureAccount(expected: Int, accountId: String) {
        if (identityEpoch != expected || credential?.account?.id != accountId) throw CancellationException("Account changed")
    }

    private suspend fun ensureTicket(): DeviceSession = ticketLock.withLock {
        val account = credential ?: throw IllegalStateException("请先登录 LoliCode")
        val local = identity ?: throw IllegalStateException("设备身份未就绪")
        val expected = identityEpoch
        ticket?.takeUnless { it.needsRenewal() }?.let {
            require(it.accountId == account.account.id && it.device.deviceId == local.deviceId) { "设备会话归属不匹配" }
            return@withLock it
        }
        val renewed = withContext(Dispatchers.IO) { accountRelay.session(account, local.deviceId, "${Build.MANUFACTURER} ${Build.MODEL}", local.identity) }
        ensureAccount(expected, account.account.id)
        ticket = renewed
        renewed
    }

    private fun checkPeerPin(desktop: AccountDevice) {
        val previous = mutable.value.computers.firstOrNull { it.desktopDeviceId == desktop.deviceId }
        require(previous == null || previous.desktopFingerprint == desktop.fingerprint) { "电脑身份密钥发生变化，请先移除旧设备并重新授权" }
    }

    private fun verifyRequest(request: EnrollmentRequest, desktop: AccountDevice, accountId: String, local: StoredIdentity) {
        require(request.accountId == accountId && request.desktop.deviceId == desktop.deviceId &&
            request.desktop.publicKey == desktop.publicKey && request.desktop.fingerprint == desktop.fingerprint &&
            request.phone.deviceId == local.deviceId && request.phone.publicKey == local.identity.publicKeySpki &&
            request.phone.fingerprint == local.identity.fingerprint) { "连接申请身份不匹配" }
        checkPeerPin(desktop)
    }

    private suspend fun refreshAccount(recover: Boolean = false) {
        val account = credential?.account ?: return
        val local = identity ?: return
        val expected = identityEpoch
        val directoryAtStart = directoryGeneration
        val session = try { ensureTicket() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) {
            if (identityEpoch == expected && credential?.account?.id == account.id && directoryGeneration == directoryAtStart) invalidateDirectory()
            throw failure
        }
        val elapsed = SystemClock.elapsedRealtime()
        val devices = if (recover || lastDevicesAt == null || elapsed - lastDevicesAt!! >= 30_000) {
            lastDevicesAt = elapsed
            val requestGeneration = ++directoryGeneration
            val fetched = try { withContext(Dispatchers.IO) { accountRelay.devices(session) } } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) {
                if (identityEpoch == expected && credential?.account?.id == account.id && directoryGeneration == requestGeneration) invalidateDirectory()
                throw failure
            }
            ensureAccount(expected, account.id)
            if (directoryGeneration == requestGeneration) { publishDirectory(account.id, fetched); fetched }
            else mutable.value.discoveredComputers
        } else mutable.value.discoveredComputers
        ensureAccount(expected, account.id)
        if (lastPresenceAt == null || SystemClock.elapsedRealtime() - lastPresenceAt!! >= 60_000) {
            withContext(Dispatchers.IO) { accountRelay.presence(session) }
            ensureAccount(expected, account.id); lastPresenceAt = SystemClock.elapsedRealtime()
        }
        var pending = mutable.value.enrollment
        if (pending == null && recover) {
            val requests = withContext(Dispatchers.IO) { accountRelay.requests(session) }
            ensureAccount(expected, account.id)
            if (mutable.value.enrollment != null) return
            pending = requests.filter { it.accountId == account.id && it.phone.deviceId == local.deviceId &&
                it.expiresAt > System.currentTimeMillis() && it.status != "rejected" && mutable.value.computers.none { c -> c.id == it.roomId } }
                .maxByOrNull { it.createdAt }
        }
        if (pending != null && pending.status != "rejected") {
            if (pending.expiresAt <= System.currentTimeMillis() && pending.status == "pending") {
                mutable.update { it.copy(enrollment = null) }; return
            }
            if (pending.status == "pending") {
                val updated = withContext(Dispatchers.IO) { accountRelay.request(session, pending) }
                ensureAccount(expected, account.id)
                if (mutable.value.enrollment?.requestId?.let { it != pending.requestId } == true) return
                require(updated.requestId == pending.requestId && updated.challenge == pending.challenge) { "连接申请发生变化" }
                verifyRequest(updated, pending.desktop, account.id, local)
                pending = updated
            }
            val desktop = devices.firstOrNull { it.deviceId == pending.desktop.deviceId } ?: throw IllegalStateException("申请对应的电脑已不在当前账号")
            verifyRequest(pending, desktop, account.id, local)
            mutable.update { it.copy(enrollment = pending) }
            consumeEnrollment(pending)
        }
    }

    private fun consumeEnrollment(request: EnrollmentRequest) {
        if (request.status != "approved" || mutable.value.computers.any { it.id == request.roomId }) return
        val account = credential?.account ?: throw IllegalStateException("账号已退出")
        val local = identity ?: throw IllegalStateException("设备身份未就绪")
        val computer = openEnrollment(request, account.id, local.deviceId, local.identity, request.desktop,
            request.requestId, accountRelay.webSocketUrl, allowLocal = BuildConfig.ALLOW_LOCAL_RELAY)
        store.upsert(computer)
        mutable.update { accountState(it).copy(computers = store.computers(account.id), selectedRoom = computer.id,
            enrollment = request, connection = "电脑已授权，正在连接加密通道…") }
        connect()
    }

    private fun startAccountPolling() {
        accountPoll?.cancel()
        if (!visible || credential == null) return
        accountPoll = viewModelScope.launch {
            val cycle = AccountPollCycle()
            while (isActive && visible && credential != null) {
                try { cycle.refresh { recover -> refreshAccount(recover = recover) } }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: AccountExpired) { ticket = null; invalidateDirectory(); disconnect(); error(failure.message ?: "账号会话已失效，请重新连接"); break }
                catch (failure: Exception) { error(failure.message ?: "无法刷新账号设备") }
                delay(cycle.nextDelayMs(enrollmentVisible, mutable.value.enrollment?.status == "pending"))
            }
        }
    }

    private fun accountOperation(block: suspend () -> Unit) {
        if (mutable.value.accountBusy) return
        accountJob = viewModelScope.launch {
            val expected = identityEpoch
            mutable.update { it.copy(accountBusy = true, error = null) }
            try { block() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (identityEpoch == expected) {
                    if (failure is AccountExpired) { ticket = null; invalidateDirectory() }
                    error(failure.message ?: "账号设备操作失败")
                }
            }
            finally { if (identityEpoch == expected) mutable.update { it.copy(accountBusy = false) } }
        }
    }

    fun selectProject(path: String) = operation {
        require(mutable.value.projects.any { it.path == path }) { "项目不属于当前电脑" }
        mutable.update { it.copy(selectedProject = path, models = emptyList(), selectedModel = "") }
        loadModels(path)
    }
    fun selectModel(id: String) { mutable.update { it.copy(selectedModel = id) } }
    fun selectSession(id: String) = operation {
        require(mutable.value.sessions.any { it.id == id }) { "此会话不属于当前设备" }
        mutable.update { it.copy(selectedSession = id, snapshot = null) }
        loadSnapshot()
    }

    fun createSession() = operation {
        val expected = generation
        val current = mutable.value
        require(current.selectedProject.isNotBlank() && current.selectedModel.isNotBlank()) { "请先选择项目和模型" }
        val created = remote().request("session.create", buildJsonObject {
            put("projectPath", current.selectedProject); put("modelId", current.selectedModel)
        }).jsonObject.let(Session::parse)
        ensureCurrent(expected)
        mutable.update { it.copy(sessions = listOf(created) + it.sessions.filterNot { s -> s.id == created.id }, selectedSession = created.id, snapshot = null) }
        loadSnapshot()
    }

    fun sendMessage(message: String, onAccepted: () -> Unit) = operation {
        val expected = generation
        val trimmed = message.trim()
        require(trimmed.isNotEmpty()) { "请输入任务" }
        require(trimmed.toByteArray(Charsets.UTF_8).size <= PacketCipher.MAX_TASK_TEXT) { "任务正文不能超过 20 KiB，请缩短内容" }
        val id = mutable.value.selectedSession ?: throw IllegalStateException("请先新建或选择会话")
        remote().request("message.send", buildJsonObject { put("sessionId", id); put("text", trimmed) })
        ensureCurrent(expected)
        onAccepted()
        loadSnapshot()
    }

    fun cancel() = operation {
        val id = mutable.value.selectedSession ?: return@operation
        remote().request("run.cancel", buildJsonObject { put("sessionId", id) })
        loadSnapshot()
    }

    fun replyPermission(id: String, allow: Boolean) = operation {
        val sessionId = mutable.value.selectedSession ?: return@operation
        val latest = readSnapshot(sessionId)
        mutable.update { it.copy(snapshot = latest) }
        require(latest.approvals.any { it.id == id }) { "此审批已处理或过期，已刷新当前状态" }
        remote().request("permission.reply", buildJsonObject {
            put("sessionId", sessionId); put("permissionId", id); put("decision", if (allow) "once" else "reject")
        })
        loadSnapshot()
    }

    fun replyQuestion(id: String, answers: JsonObject) = operation {
        val sessionId = mutable.value.selectedSession ?: return@operation
        val latest = readSnapshot(sessionId)
        mutable.update { it.copy(snapshot = latest) }
        require(latest.questions.any { it.id == id }) { "此问题已处理或过期，已刷新当前状态" }
        remote().request("question.reply", buildJsonObject {
            put("sessionId", sessionId); put("questionId", id); put("answers", answers)
        })
        loadSnapshot()
    }

    fun refresh() = operation { refreshAll() }

    fun openNotification(roomId: String, sessionId: String) {
        val computer = mutable.value.computers.firstOrNull { it.id == roomId && it.approved }
        if (computer == null) { error("通知对应的电脑已移除或未配对"); return }
        notificationSession = sessionId
        if (mutable.value.selectedRoom != roomId) {
            mutable.update { accountState(it).copy(computers = it.computers, selectedRoom = roomId) }
            connect()
        } else if (mutable.value.usable) operation { refreshAll() }
    }

    private fun connect() {
        disconnect()
        if (!visible) return
        val computer = mutable.value.computer ?: return
        if (computer.accountId == null) { error("请通过账号重新授权电脑，旧版配对已封存"); return }
        val connectionGeneration = generation
        connectionJob = viewModelScope.launch {
            try {
                val deviceToken = ensureTicket().deviceToken
                ensureCurrent(connectionGeneration)
                require(computer.accountId == credential?.account?.id) { "电脑不属于当前账号" }
                openConnection(computer, deviceToken, connectionGeneration)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (failure is AccountExpired) ticket = null
                if (generation == connectionGeneration) {
                    invalidateDirectory()
                    error(failure.message ?: "无法连接账号设备")
                    mutable.update { it.copy(connection = "账号设备连接未就绪，请重试") }
                }
            }
        }
    }

    private fun openConnection(computer: PairedComputer, deviceToken: String?, connectionGeneration: Int) {
        textRevision = null; seenEvents.clear()
        // QR expiration applies only when importing a new enrollment. A saved
        // pending room may already be approved while this phone was offline.
        // Re-authenticate and let the desktop decide its current authorization.
        mutable.update { it.copy(relayReady = false, desktopOnline = false, hostVerified = false, transport = null, connection = "正在建立 ${computer.name} 的加密直连…", pushConfigured = false, pushRegistered = false, pushError = null) }
        val connection = RemoteClient(computer, "${Build.MANUFACTURER} ${Build.MODEL}", deviceToken,
            DirectPeerFactory { events -> NativeDirectPeer(getApplication<Application>(), events) }) { event -> viewModelScope.launch {
            if (!visible || generation != connectionGeneration) return@launch
            when (event) {
                ConnectionEvent.Ready -> {
                    textRevision = null
                    retries = 0
                    mutable.update { it.copy(relayReady = true, transport = "direct", connection = "原生直连已建立，正在验证电脑任务状态") }
                    if (mutable.value.computer?.approved == true) registerPush()
                    if (mutable.value.desktopOnline && mutable.value.computer?.approved == true) bootstrap()
                }
                is ConnectionEvent.TransportReady -> {
                    textRevision = null; seenEvents.clear(); retries = 0
                    mutable.update { it.copy(relayReady = true, hostVerified = false, transport = "text", connection = "受限文本通道已验证 · 正在确认电脑授权") }
                }
                is ConnectionEvent.WaitingForTransport -> {
                    textRevision = null; seenEvents.clear(); poll?.cancel(); eventRefresh?.cancel()
                    mutable.update { it.copy(relayReady = false, hostVerified = false, transport = null, connection = event.reason) }
                }
                is ConnectionEvent.Peer -> {
                    mutable.update { it.copy(desktopOnline = event.online, hostVerified = if (event.online) it.hostVerified else false, transport = if (event.online) it.transport else null, connection = when {
                        !event.online -> "直连尚未就绪；可在设备列表查看电脑在线状态"
                        it.computer?.approved != true -> "电脑在线，请在电脑上确认此次配对"
                        it.transport == "direct" -> "原生直连已建立 · 电脑静默后台执行"
                        it.transport == "text" -> "受限文本模式 · 电脑静默后台执行"
                        else -> "正在建立加密直连，不会通过服务器转发任务"
                    }) }
                    if (event.online && mutable.value.transport == "direct" && mutable.value.relayReady && mutable.value.computer?.approved == true) bootstrap()
                }
                is ConnectionEvent.PushStatus -> mutable.update { it.copy(pushConfigured = event.configured, pushRegistered = event.registered) }
                is ConnectionEvent.Plaintext -> handlePlaintext(event.message)
                is ConnectionEvent.Closed -> {
                    poll?.cancel()
                    if (event.authenticationRejected) ticket = null
                    mutable.update { it.copy(relayReady = false, desktopOnline = false, hostVerified = false, transport = null, connection = event.reason) }
                    retry?.cancel()
                    if (event.retryable && (!event.authenticationRejected || retries < 1)) retry = viewModelScope.launch { delay((1_000L shl retries.coerceAtMost(5)).coerceAtLeast(30_000)); retries++; connect() }
                }
            }
        } }
        client = connection
        connection.connect()
        ticketRenewal?.cancel()
        if (computer.accountId != null) ticketRenewal = viewModelScope.launch {
            delay(((ticket?.expiresAt ?: 0L) - System.currentTimeMillis() - 60_000).coerceAtLeast(1_000))
            if (visible && generation == connectionGeneration) connect()
        }
    }

    private fun handlePlaintext(message: JsonObject) {
        when (message.string("type")) {
            "pair.approved" -> {
                val current = mutable.value.computer ?: return
                if (message.string("deviceId") != current.deviceId) { error("配对确认的设备不匹配"); return }
                runCatching { store.upsert(current.copy(approved = true)) }.onFailure { error("无法安全保存已配对电脑"); return }
                mutable.update { it.copy(computers = store.computers(credential?.account?.id), connection = "配对完成 · 电脑静默后台执行") }
                registerPush()
                bootstrap()
            }
            "pair.rejected" -> {
                disconnect()
                mutable.update { it.copy(relayReady = false, desktopOnline = false, hostVerified = false, connection = "电脑已拒绝配对；请移除后重新申请") }
            }
            "event" -> if (mutable.value.usable) {
                val id = message.string("eventId")
                if (id.isNotBlank()) {
                    runCatching { client?.acknowledgeEvent(id) }
                    if (!seenEvents.add(id)) return
                    if (seenEvents.size > 1024) seenEvents.remove(seenEvents.first())
                }
                if (eventRefresh?.isActive == true) return
                val expected = generation
                eventRefresh = viewModelScope.launch {
                    delay(if (mutable.value.transport == "text") 500 else 250)
                    if (generation == expected) runCatching { loadSnapshot(minimumInterval = if (mutable.value.transport == "text") 3_000 else 1_000) }
                }
            }
        }
    }

    private fun bootstrap() {
        poll?.cancel()
        poll = viewModelScope.launch {
            runCatching { refreshAll() }.onFailure { if (visible) error(it.message ?: "读取电脑状态失败") }
            while (isActive && visible) {
                delay(if (mutable.value.transport == "text") 3_000 else 2_000)
                if (mutable.value.usable && !mutable.value.busy && mutable.value.snapshot?.status == "running") runCatching { loadSnapshot(minimumInterval = if (mutable.value.transport == "text") 3_000 else 1_000) }
            }
        }
    }

    private suspend fun refreshAll() {
        val refreshGeneration = generation
        val connection = transport()
        val status = connection.request("status").jsonObject
        ensureCurrent(refreshGeneration)
        require(status.long("protocol") == 1L && status.boolean("quietMode")) { "电脑未确认静默后台模式，已暂停操作，请更新电脑端" }
        mutable.update { it.copy(hostVerified = true) }
        val projects = connection.request("projects.list").jsonArray.map { Project(it.jsonObject.string("path"), it.jsonObject.string("name")) }
        val sessions = connection.request("sessions.list").jsonArray.map { Session.parse(it.jsonObject) }
        ensureCurrent(refreshGeneration)
        val current = mutable.value
        val project = current.selectedProject.takeIf { selected -> projects.any { it.path == selected } } ?: projects.firstOrNull()?.path.orEmpty()
        val requested = notificationSession
        val selected = requested?.takeIf { id -> sessions.any { it.id == id } }
            ?: current.selectedSession?.takeIf { id -> sessions.any { it.id == id } }
            ?: sessions.firstOrNull()?.id
        if (requested != null) {
            notificationSession = null
            if (sessions.none { it.id == requested }) error("通知对应的会话已失效，不能使用旧通知审批")
        }
        mutable.update { it.copy(projects = projects, selectedProject = project, sessions = sessions, selectedSession = selected) }
        if (project.isNotBlank() && (current.selectedProject != project || current.models.isEmpty())) loadModels(project)
        loadSnapshot()
    }

    private suspend fun loadModels(path: String) {
        val modelGeneration = generation
        val catalog = remote().request("models.list", buildJsonObject { put("projectPath", path) }).jsonObject
        ensureCurrent(modelGeneration)
        val models = catalog.array("models").map { Model(it.jsonObject.string("id"), it.jsonObject.string("name")) }
        if (mutable.value.selectedProject != path) return
        mutable.update { it.copy(models = models, selectedModel = it.selectedModel.takeIf { id -> models.any { m -> m.id == id } } ?: models.firstOrNull()?.id.orEmpty()) }
    }

    private suspend fun loadSnapshot(minimumInterval: Long = 0) = snapshotLock.withLock {
        if (minimumInterval > 0) delay((minimumInterval - (SystemClock.elapsedRealtime() - lastSnapshotAt)).coerceAtLeast(0))
        val id = mutable.value.selectedSession ?: return@withLock
        val room = mutable.value.selectedRoom
        val snapshot = readSnapshot(id)
        if (mutable.value.selectedSession == id && mutable.value.selectedRoom == room) {
            lastSnapshotAt = SystemClock.elapsedRealtime()
            mutable.update { it.copy(snapshot = snapshot, sessions = it.sessions.map { session -> if (session.id == id) snapshot.session else session }) }
        }
    }
    private suspend fun readSnapshot(id: String): SessionSnapshot {
        val expected = generation
        val previous = mutable.value.snapshot?.takeIf { it.session.id == id }
        val known = if (mutable.value.transport == "text" && previous != null) textRevision?.takeIf { it.first == id && it.second == previous.revision }?.second else null
        val value = remote().request("session.get", buildJsonObject { put("sessionId", id); known?.let { put("knownRevision", it) } }).jsonObject
        ensureCurrent(expected)
        val snapshot = applySnapshotResponse(value, previous, known)
        if (mutable.value.transport == "text") textRevision = snapshot.revision?.let { id to it }
        return snapshot
    }
    private fun remote(): RemoteClient {
        check(mutable.value.usable) { "请等待电脑上线并完成配对" }
        return transport()
    }
    private fun transport(): RemoteClient {
        val current = mutable.value
        check(current.transport in setOf("direct", "text") && current.relayReady && current.desktopOnline && current.computer?.approved == true) { "请等待电脑建立加密通道并完成授权" }
        return client ?: throw IllegalStateException("连接尚未就绪")
    }
    private fun registerPush() {
        if (BuildConfig.PUSH_CONFIGURED) runCatching { client?.registerPush(store.pushToken()) }
    }
    private fun ensureCurrent(expected: Int) {
        if (!visible || generation != expected) throw CancellationException("Connection changed")
    }
    private fun operation(block: suspend () -> Unit): Job = viewModelScope.launch {
        if (mutable.value.busy) return@launch
        mutable.update { it.copy(busy = true, error = null) }
        try { block() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error(failure.message ?: "操作失败；请刷新任务状态后再继续") }
        finally { mutable.update { it.copy(busy = false) } }
    }
    private fun error(message: String) { mutable.update { it.copy(error = message.take(500)) } }
    private fun disconnect() {
        generation++
        connectionJob?.cancel(); connectionJob = null
        ticketRenewal?.cancel(); ticketRenewal = null
        eventRefresh?.cancel(); eventRefresh = null; lastSnapshotAt = 0L
        retry?.cancel(); retry = null
        poll?.cancel(); poll = null
        client?.close(); client = null
        mutable.update { it.copy(relayReady = false, desktopOnline = false, hostVerified = false, transport = null) }
    }
    override fun onCleared() { accountJob?.cancel(); accountPoll?.cancel(); presenceExpiry?.cancel(); disconnect(); super.onCleared() }
}
