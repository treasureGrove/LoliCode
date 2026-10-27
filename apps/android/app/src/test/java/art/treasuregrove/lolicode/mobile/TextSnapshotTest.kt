package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TextSnapshotTest {
    private fun baseline() = SessionSnapshot.parse(wireJson.parseToJsonElement("""{"session":{"id":"s1","title":"Fixture","projectPath":"fixture"},"status":"running","messages":[{"role":"assistant","parts":[{"type":"text","text":"已收到的正文"}]}],"permissions":[],"questions":[],"diffs":[],"revision":"revision-one"}""").jsonObject)
    @Test fun notModifiedKeepsTheExactRenderedSnapshot() {
        val previous = baseline()
        val reply = buildJsonObject { put("notModified", true); put("revision", "revision-one") }
        assertSame(previous, applySnapshotResponse(reply, previous, previous.revision))
        assertThrows(Exception::class.java) { applySnapshotResponse(reply, null, "revision-one") }
        assertThrows(Exception::class.java) { applySnapshotResponse(reply, previous, "revision-other-epoch") }
        assertThrows(Exception::class.java) { applySnapshotResponse(reply, previous, null) }
        assertThrows(Exception::class.java) { applySnapshotResponse(reply, previous.copy(revision = "older"), "revision-one") }
    }
    @Test fun projectedApprovalCannotEnableAllowWithoutFullDetails() {
        val data = wireJson.parseToJsonElement("""{"session":{"id":"s1"},"status":"waiting_permission","messages":[],"permissions":[{"id":"p1","action":"shell","description":"摘要","requiresDirect":true,"canApprove":false}],"questions":[],"diffs":[],"revision":"rev"}""").jsonObject
        assertFalse(SessionSnapshot.parse(data).approvals.single().canApprove)
        assertTrue(baseline().messages.single().body.isNotBlank())
    }
}
