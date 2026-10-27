package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class LocalAnswerGatherGateTest {
    @Test fun initialEmptyCompleteWaitsForLateCandidateAndPublishesExactlyOnce() {
        val gate = LocalAnswerGatherGate()
        assertTrue(gate.localDescriptionSet())
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(gatherComplete = true, hasCandidate = false))
        // First host and then srflx callbacks cannot trust the getter's stale COMPLETE.
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertEquals(AnswerGatherDecision.PUBLISH, gate.observe(true, true, AnswerGatherEvent.COMPLETE))
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(gatherComplete = true, hasCandidate = true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.deadline(hasCandidate = true))
    }

    @Test fun emptyAtDeadlineFailsWithoutPublishingAndCannotBeRevived() {
        val gate = LocalAnswerGatherGate()
        gate.localDescriptionSet()
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, false))
        assertEquals(AnswerGatherDecision.FAIL, gate.deadline(false))
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.deadline(true))
    }

    @Test fun deadlinePreservesTheExistingNonemptyPartialGatherPolicy() {
        val gate = LocalAnswerGatherGate()
        gate.localDescriptionSet()
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(gatherComplete = false, hasCandidate = true))
        assertEquals(AnswerGatherDecision.PUBLISH, gate.deadline(hasCandidate = true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true))
    }

    @Test fun staleCompleteAfterLateHostWaitsForDeadlineWhenThereIsNoNewCompleteEvent() {
        val gate = LocalAnswerGatherGate()
        gate.localDescriptionSet()
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, false, AnswerGatherEvent.COMPLETE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertEquals(AnswerGatherDecision.PUBLISH, gate.deadline(true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true, AnswerGatherEvent.COMPLETE))
    }

    @Test fun emptyCompleteBeforeSetLocalSuccessStillBlocksTheStaleHostSnapshot() {
        val gate = LocalAnswerGatherGate()
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, false, AnswerGatherEvent.COMPLETE))
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertTrue(gate.localDescriptionSet())
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true))
        assertEquals(AnswerGatherDecision.PUBLISH, gate.observe(true, true, AnswerGatherEvent.COMPLETE))
    }

    @Test fun anotherEmptyCompleteCannotClearTheLateCandidateBarrier() {
        val gate = LocalAnswerGatherGate()
        gate.localDescriptionSet()
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, false, AnswerGatherEvent.COMPLETE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, false, AnswerGatherEvent.COMPLETE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.COMPLETE))
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, true, AnswerGatherEvent.CANDIDATE))
        assertEquals(AnswerGatherDecision.PUBLISH, gate.observe(true, true, AnswerGatherEvent.COMPLETE))
    }

    @Test fun callbackBeforeLocalDescriptionIsSetCannotLatchOrLoseTheLaterReadyAnswer() {
        val gate = LocalAnswerGatherGate()
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.deadline(true))
        assertTrue(gate.localDescriptionSet())
        assertFalse(gate.localDescriptionSet())
        assertEquals(AnswerGatherDecision.PUBLISH, gate.observe(true, true))
    }

    @Test fun closeBeforeSetLocalIgnoresLateSuccessCandidatesAndDeadline() {
        val gate = LocalAnswerGatherGate()
        gate.close()
        assertFalse(gate.localDescriptionSet())
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.deadline(false))
    }

    @Test fun closeWhileWaitingIgnoresQueuedCandidateCompleteAndTimeout() {
        val gate = LocalAnswerGatherGate()
        gate.localDescriptionSet()
        assertEquals(AnswerGatherDecision.WAIT, gate.observe(true, false))
        gate.close()
        assertEquals(AnswerGatherDecision.IGNORE, gate.observe(true, true))
        assertEquals(AnswerGatherDecision.IGNORE, gate.deadline(true))
    }

    @Test fun candidateMustActuallyBeInTheCurrentSdpAndHaveAUsablePortAndType() {
        assertFalse(hasUsableLocalCandidate("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"))
        assertFalse(hasUsableLocalCandidate("a=candidate:"))
        assertFalse(hasUsableLocalCandidate("a=candidate:1 1 udp 1 example.local 0 typ host"))
        assertFalse(hasUsableLocalCandidate("a=candidate:1 1 udp 1 example.local 5000 typ relay"))
        assertTrue(hasUsableLocalCandidate("a=candidate:1 1 udp 2122260223 example.local 5000 typ host generation 0"))
        assertTrue(hasUsableLocalCandidate("a=candidate:2 1 UDP 1686052607 2001:db8::1 5001 typ srflx"))
        assertTrue(hasUsableLocalCandidate("a=candidate:3 1 tcp 1518280447 example.local 9 typ host tcptype active"))
    }
}
