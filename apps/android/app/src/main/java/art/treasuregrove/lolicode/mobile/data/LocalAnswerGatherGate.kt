package art.treasuregrove.lolicode.mobile.data

internal enum class AnswerGatherDecision { WAIT, PUBLISH, FAIL, IGNORE }
internal enum class AnswerGatherEvent { LOCAL_DESCRIPTION, CANDIDATE, COMPLETE }

/** COMPLETE can precede Android's first network/candidate callback. Never latch an empty answer. */
internal class LocalAnswerGatherGate {
    private var localDescriptionReady = false
    private var terminal = false
    private var sawEmptyComplete = false
    private var candidateAfterEmpty = false
    private var completeAfterCandidate = false

    @Synchronized fun localDescriptionSet(): Boolean {
        if (terminal || localDescriptionReady) return false
        localDescriptionReady = true
        return true
    }

    @Synchronized fun observe(gatherComplete: Boolean, hasCandidate: Boolean,
        event: AnswerGatherEvent = AnswerGatherEvent.LOCAL_DESCRIPTION): AnswerGatherDecision {
        if (terminal) return AnswerGatherDecision.IGNORE
        // Keep history even when a COMPLETE callback is queued before setLocal success.
        if ((gatherComplete || event == AnswerGatherEvent.COMPLETE) && !hasCandidate) {
            sawEmptyComplete = true
            candidateAfterEmpty = false
            completeAfterCandidate = false
        }
        if (sawEmptyComplete && event == AnswerGatherEvent.CANDIDATE) candidateAfterEmpty = true
        if (event == AnswerGatherEvent.COMPLETE && candidateAfterEmpty && gatherComplete && hasCandidate) completeAfterCandidate = true
        if (!localDescriptionReady) return AnswerGatherDecision.IGNORE
        if (!gatherComplete || !hasCandidate) return AnswerGatherDecision.WAIT
        // A stale COMPLETE getter on the first late host callback must not omit a later srflx.
        if (sawEmptyComplete && !completeAfterCandidate) return AnswerGatherDecision.WAIT
        terminal = true
        return AnswerGatherDecision.PUBLISH
    }

    @Synchronized fun deadline(hasCandidate: Boolean): AnswerGatherDecision {
        if (terminal || !localDescriptionReady) return AnswerGatherDecision.IGNORE
        terminal = true
        return if (hasCandidate) AnswerGatherDecision.PUBLISH else AnswerGatherDecision.FAIL
    }

    @Synchronized fun close() { terminal = true }
}

private val candidateFields = Regex("\\s+")

/** Inspect the SDK's current SDP, rather than treating a previous callback as a stored candidate. */
internal fun hasUsableLocalCandidate(sdp: String): Boolean = sdp.lineSequence().any { raw ->
    val line = raw.trim()
    if (!line.startsWith("a=candidate:", true)) return@any false
    val fields = line.split(candidateFields)
    fields.size >= 8 && fields[0].length > "a=candidate:".length &&
        fields[1].toIntOrNull()?.let { it > 0 } == true &&
        fields[2].lowercase() in setOf("udp", "tcp") &&
        fields[3].toLongOrNull()?.let { it in 0..4_294_967_295L } == true &&
        fields[4].isNotBlank() && fields[5].toIntOrNull()?.let { it in 1..65535 } == true &&
        fields[6].equals("typ", true) && fields[7].lowercase() in setOf("host", "srflx", "prflx")
}
