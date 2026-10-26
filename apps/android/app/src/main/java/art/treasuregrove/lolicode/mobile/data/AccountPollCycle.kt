package art.treasuregrove.lolicode.mobile.data

import kotlinx.coroutines.CancellationException

/** Offline approval recovery remains required until a complete refresh succeeds. */
internal class AccountPollCycle {
    private var recoveryRequired = true
    private var failed = false

    suspend fun refresh(block: suspend (recover: Boolean) -> Unit) {
        try {
            block(recoveryRequired)
            recoveryRequired = false
            failed = false
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { failed = true; throw failure }
    }

    fun nextDelayMs(enrollmentVisible: Boolean, pending: Boolean): Long =
        if (!failed && enrollmentVisible && pending) 3_000 else 30_000
}
