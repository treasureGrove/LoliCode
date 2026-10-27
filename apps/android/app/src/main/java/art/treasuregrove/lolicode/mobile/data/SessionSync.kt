package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*

/** Legacy/direct arrays and bounded text directory pages share the same UI model. */
data class SessionDirectory(val sessions: List<Session>, val nextOffset: Int? = null, val total: Int = sessions.size,
    val offset: Int = 0, val revision: String? = null, val directoryRevision: String? = null) {
    companion object {
        fun parse(value: JsonElement): SessionDirectory {
            val rows = if (value is JsonArray) value else value.jsonObject.array("sessions")
            val sessions = rows.map { Session.parse(it.jsonObject) }
            require(sessions.all { it.id.isNotBlank() } && sessions.map { it.id }.distinct().size == sessions.size) { "电脑返回的会话目录无效" }
            if (value is JsonArray) return SessionDirectory(sessions)
            val data = value.jsonObject
            val next = if (data.boolean("hasMore")) (data["nextOffset"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 } else null
            require(!data.boolean("hasMore") || next != null) { "会话目录分页无效" }
            return SessionDirectory(sessions, next, ((data["total"] as? JsonPrimitive)?.intOrNull ?: sessions.size).coerceAtLeast(sessions.size),
                ((data["offset"] as? JsonPrimitive)?.intOrNull ?: 0).coerceAtLeast(0), data.string("revision").ifBlank { null }, data.string("directoryRevision").ifBlank { null })
        }
    }
}

fun applyDirectoryResponse(value: JsonElement, previous: SessionDirectory?, knownRevision: String?): SessionDirectory {
    if (value is JsonObject && value.boolean("notModified")) {
        require(previous != null && knownRevision != null && previous.revision == knownRevision && value.string("revision") == knownRevision) { "会话目录增量基线已失效" }
        return previous
    }
    return SessionDirectory.parse(value)
}

fun firstDirectoryRows(directory: SessionDirectory, cached: List<Session>, selected: String?): List<Session> =
    directory.sessions + if (directory.nextOffset != null) cached.filter { row -> row.id == selected && directory.sessions.none { it.id == row.id } } else emptyList()

private const val MAX_HISTORY_MESSAGES = 500
private const val MAX_HISTORY_TEXT_BYTES = 512 * 1024

private fun SessionSnapshot.withHistory(messages: List<ChatMessage>, cappedAlready: Boolean = false): SessionSnapshot {
    var bytes = 0
    val kept = messages.asReversed().takeWhileIndexed { index, message ->
        bytes += message.body.toByteArray(Charsets.UTF_8).size
        index < MAX_HISTORY_MESSAGES && bytes <= MAX_HISTORY_TEXT_BYTES
    }.asReversed()
    val capped = cappedAlready || kept.size < messages.size
    return copy(messages = kept, historyOffset = 0, nextHistoryOffset = if (!capped && kept.size < historyTotal) kept.size else null, historyCapped = capped)
}

private inline fun <T> List<T>.takeWhileIndexed(predicate: (Int, T) -> Boolean): List<T> {
    val result = ArrayList<T>()
    for ((index, value) in withIndex()) { if (!predicate(index, value)) break; result.add(value) }
    return result
}

/** Keep explicitly fetched older pages while replacing the mutable newest text by stable message ID. */
fun mergeLatestSnapshot(incoming: SessionSnapshot, previous: SessionSnapshot?): SessionSnapshot {
    val refreshedMessages = incoming.messages.map { fresh ->
        val expanded = previous?.messages?.firstOrNull { it.id == fresh.id && it.loadedBytes > 0 && it.revision != null && it.revision == fresh.revision }
        if (expanded != null) expanded.copy(role = fresh.role, textTotal = fresh.textTotal) else fresh
    }
    val latest = if (refreshedMessages == incoming.messages) incoming else incoming.copy(messages = refreshedMessages)
    require(latest.historyOffset == 0) { "最新会话页位置无效" }
    if (previous == null || latest.session.id != previous.session.id || latest.messages.isEmpty() ||
        latest.messages.any { it.id.isBlank() } || previous.messages.any { it.id.isBlank() } ||
        latest.historyTotal < previous.historyTotal ||
        (latest.historyRevision != null && latest.historyRevision != previous.historyRevision)) return latest
    val firstOverlap = latest.messages.indexOfFirst { fresh -> previous.messages.any { it.id == fresh.id } }
    if (firstOverlap < 0) return latest // A gap/reset is explicit: restart from the latest page and offer older pages again.
    val before = previous.messages.takeWhile { it.id != latest.messages[firstOverlap].id }
    // If the newest page starts before the overlap, those earlier rows replace any cached versions too.
    val freshIds = latest.messages.mapTo(hashSetOf()) { it.id }
    return latest.withHistory(before.filterNot { it.id in freshIds } + latest.messages, previous.historyCapped)
}

/** Older pages cannot replace current approvals/status/revision, or cross a changed history baseline. */
fun mergeOlderSnapshot(current: SessionSnapshot, older: SessionSnapshot, requestedOffset: Int): SessionSnapshot {
    require(current.session.id == older.session.id) { "会话已切换，请重新读取历史" }
    require(current.nextHistoryOffset == requestedOffset && older.historyOffset == requestedOffset) { "历史分页位置已失效，请刷新后重试" }
    require(current.historyTotal == older.historyTotal) { "会话记录已更新，请刷新后重试" }
    require(current.historyRevision == older.historyRevision) { "会话历史已变化，请刷新后重试" }
    require(older.messages.isNotEmpty() && older.messages.all { it.id.isNotBlank() } && current.messages.all { it.id.isNotBlank() }) { "此电脑不支持历史分页，请更新电脑端" }
    val currentIds = current.messages.mapTo(hashSetOf()) { it.id }
    val added = older.messages.filterNot { it.id in currentIds }
    require(added.isNotEmpty()) { "历史分页没有前进，请刷新后重试" }
    return current.withHistory(added + current.messages, current.historyCapped)
}

fun selectSyncedSession(sessions: List<Session>, selected: String?, requested: String? = null): String? =
    requested?.takeIf { id -> sessions.any { it.id == id } }
        ?: selected?.takeIf { id -> sessions.any { it.id == id } }
        // Listing a desktop session is not consent to attach it. Only restore an explicit prior selection.

data class MessageTextPage(val sessionId: String, val messageId: String, val text: String, val offset: Int,
    val nextOffset: Int?, val total: Int, val revision: String) {
    companion object {
        fun parse(data: JsonObject): MessageTextPage {
            val offset = (data["offset"] as? JsonPrimitive)?.intOrNull ?: error("正文分页位置无效")
            val total = (data["total"] as? JsonPrimitive)?.intOrNull ?: error("正文长度无效")
            val bytes = data.string("text").toByteArray(Charsets.UTF_8).size
            val next = if (data.boolean("hasMore")) (data["nextOffset"] as? JsonPrimitive)?.intOrNull else null
            require(offset >= 0 && total >= offset && bytes <= total - offset && data.string("revision").isNotBlank()) { "正文分页无效" }
            require(if (data.boolean("hasMore")) next != null && next == offset + bytes && bytes > 0 && next < total else offset + bytes == total) { "正文分页没有前进" }
            return MessageTextPage(data.string("sessionId"), data.string("messageId"), data.string("text"), offset, next, total, data.string("revision"))
        }
    }
}

fun applyMessagePage(sessionId: String, message: ChatMessage, page: MessageTextPage, requestedOffset: Int): ChatMessage {
    require(sessionId == page.sessionId && message.id == page.messageId && page.offset == requestedOffset) { "正文所属会话或消息不匹配" }
    require(requestedOffset == 0 || (message.loadedBytes == requestedOffset && message.revision == page.revision)) { "正文已更新，请重新展开" }
    val body = if (requestedOffset == 0) page.text else message.body + page.text
    require(body.toByteArray(Charsets.UTF_8).size <= MAX_HISTORY_TEXT_BYTES) { "手机文字缓存已达 512 KiB，请在电脑查看后续内容" }
    return message.copy(body = body, revision = page.revision, textTotal = page.total, loadedBytes = page.offset + page.text.toByteArray(Charsets.UTF_8).size,
        textTruncated = page.nextOffset != null, textCapped = false)
}
