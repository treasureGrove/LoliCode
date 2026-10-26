package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.SessionSnapshot
import art.treasuregrove.lolicode.mobile.protocol.wireJson
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class SnapshotTest {
    @Test fun pendingApprovalsAndChangesAreReadFromAuthoritativeSnapshot() {
        val snapshot = SessionSnapshot.parse(wireJson.parseToJsonElement("""
            {"session":{"id":"s1","title":"修复测试","projectPath":"D:/project"},"status":"waiting_permission",
             "messages":[{"role":"assistant","parts":[{"type":"text","text":"需要修改文件"},{"type":"tool","name":"edit_file","state":"pending","input":{}}]}],
             "permissions":[{"id":"p1","action":"edit","resources":["src/a.kt"],"toolInput":{"path":"src/a.kt"}}],
             "questions":[],"diffs":[{"path":"src/a.kt","patch":"+ val a = 1"}],"truncated":true}
        """.trimIndent()).jsonObject)
        assertEquals("s1", snapshot.session.id)
        assertEquals("p1", snapshot.approvals.single().id)
        assertTrue(snapshot.messages.single().body.contains("需要修改文件"))
        assertEquals("src/a.kt", snapshot.diffs.single().path)
        assertTrue(snapshot.truncated)
    }

    @Test fun missingApprovalIsNeverSynthesizedFromNotification() {
        val snapshot = SessionSnapshot.parse(wireJson.parseToJsonElement("""{"session":{"id":"s1","title":"完成","projectPath":"D:/p"},"status":"idle"}""").jsonObject)
        assertTrue(snapshot.approvals.isEmpty())
        assertTrue(snapshot.questions.isEmpty())
    }
}
