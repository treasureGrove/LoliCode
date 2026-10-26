package art.treasuregrove.lolicode.mobile.data

/** Directory heartbeat presence is independent of the task transport. */
enum class DevicePresence { Online, Offline, Unknown }

/** Local elapsed time only; server wall-clock timestamps never extend this cache. */
data class DirectoryFreshness(
    val accountId: String? = null,
    val fetchedAtElapsedMs: Long? = null,
    val valid: Boolean = false,
) {
    fun isFreshFor(activeAccountId: String?, nowElapsedMs: Long): Boolean {
        val fetched = fetchedAtElapsedMs ?: return false
        return valid && activeAccountId != null && validAccountId(activeAccountId) && accountId == activeAccountId && fetched >= 0 &&
            nowElapsedMs >= fetched && nowElapsedMs - fetched < MAX_AGE_MS
    }
    companion object { const val MAX_AGE_MS = 60_000L }
}
