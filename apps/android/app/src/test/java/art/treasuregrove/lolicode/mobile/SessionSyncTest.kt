package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SessionSyncTest {
    private fun page(from: Int, through: Int, total: Int = 12, offset: Int = 0, history: String = "history-one", session: String = "s1"): SessionSnapshot =
        SessionSnapshot.parse(buildJsonObject {
            put("session", buildJsonObject { put("id", session); put("title", "Desktop fixture") })
            put("status", "idle"); put("revision", "page-$from-$through"); put("historyRevision", history)
            put("historyOffset", offset); put("historyTotal", total)
            val count = through - from + 1
            put("hasMore", offset + count < total)
            if (offset + count < total) put("nextOffset", offset + count)
            put("messages", buildJsonArray {
                for (i in from..through) add(buildJsonObject {
                    put("id", "m$i"); put("role", "assistant")
                    put("parts", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", "正文$i") }) })
                })
            })
        })

    @Test fun browsingDirectoryDoesNotAttachOrChooseADesktopSession() {
        val rows = listOf(Session("desktop-a", "Already on desktop", "fixture"), Session("desktop-b", "Second", "fixture"))
        assertNull(selectSyncedSession(rows, null))
        assertEquals("desktop-b", selectSyncedSession(rows, "desktop-b"))
        assertEquals("desktop-a", selectSyncedSession(rows, "desktop-b", "desktop-a"))
        assertNull(selectSyncedSession(rows, "removed"))
        assertEquals(listOf(rows.first()), firstDirectoryRows(SessionDirectory(listOf(rows.first())), rows, "desktop-b"))
        assertEquals(rows, firstDirectoryRows(SessionDirectory(listOf(rows.first()), 1, 2), rows, "desktop-b"))
    }

    @Test fun boundedDirectorySupportsLegacyArraysAndPageScopedRevision() {
        val raw = wireJson.parseToJsonElement("""{"sessions":[{"id":"desktop-a","title":"Existing"}],"offset":0,"nextOffset":1,"hasMore":true,"total":7,"revision":"r1"}""")
        val first = SessionDirectory.parse(raw)
        assertEquals("desktop-a", first.sessions.single().id)
        assertEquals(1, first.nextOffset); assertEquals(7, first.total)
        val unchanged = buildJsonObject { put("notModified", true); put("revision", "r1") }
        assertSame(first, applyDirectoryResponse(unchanged, first, "r1"))
        assertThrows(Exception::class.java) { applyDirectoryResponse(unchanged, null, "r1") }
        assertThrows(Exception::class.java) { applyDirectoryResponse(unchanged, first, "old-epoch") }
        assertEquals(1, SessionDirectory.parse(raw.jsonObject.getValue("sessions")).sessions.size)
        assertThrows(Exception::class.java) { SessionDirectory.parse(wireJson.parseToJsonElement("""{"sessions":[{"id":"s"},{"id":"s"}]}""")) }
    }

    @Test fun olderPagesPrependStableMessagesWithoutReplacingLatestStatusOrRevision() {
        val newest = page(6, 11)
        val older = page(0, 5, offset = 6).copy(status = "running")
        val combined = mergeOlderSnapshot(newest, older, 6)
        assertEquals((0..11).map { "m$it" }, combined.messages.map { it.id })
        assertEquals("idle", combined.status); assertEquals(newest.revision, combined.revision)
        assertNull(combined.nextHistoryOffset)
        // Subsequent current-page acknowledgement keeps every explicitly loaded older row.
        assertSame(combined, applySnapshotResponse(buildJsonObject { put("notModified", true); put("revision", combined.revision) }, combined, combined.revision))
        val refreshed = mergeLatestSnapshot(page(6, 11).copy(messages = page(6, 11).messages.map { if (it.id == "m11") it.copy(body = "stream updated") else it }), combined)
        assertEquals(12, refreshed.messages.size)
        assertEquals("stream updated", refreshed.messages.last().body)
    }

    @Test fun changedHistoryOrSessionCannotBeSplicedIntoAnOlderPage() {
        val current = page(6, 11)
        assertThrows(Exception::class.java) { mergeOlderSnapshot(current, page(0, 5, offset = 6, history = "changed"), 6) }
        assertThrows(Exception::class.java) { mergeOlderSnapshot(current, page(0, 5, offset = 6, total = 13), 6) }
        assertThrows(Exception::class.java) { mergeOlderSnapshot(current, page(0, 5, offset = 6, session = "other"), 6) }
        assertThrows(Exception::class.java) { mergeOlderSnapshot(current, page(0, 5, offset = 5), 6) }
        val expanded = mergeOlderSnapshot(current, page(0, 5, offset = 6), 6)
        val changed = page(7, 12, total = 13, history = "changed")
        assertSame(changed, mergeLatestSnapshot(changed, expanded))
        assertSame(changed, mergeLatestSnapshot(changed, expanded.copy(session = Session("other", "", ""))))
    }

    @Test fun localHistoryCacheHasAnExplicitBoundRatherThanGrowingWithoutLimit() {
        val newest = page(500, 999, total = 1000)
        val older = page(0, 499, total = 1000, offset = 500)
        val bounded = mergeOlderSnapshot(newest, older, 500)
        assertEquals(500, bounded.messages.size)
        assertEquals("m500", bounded.messages.first().id)
        assertTrue(bounded.historyCapped)
        assertNull(bounded.nextHistoryOffset)
    }

    @Test fun fullLongTextIsLoadedFromTheHeadOnDemandUsingUtf8ByteOffsets() {
        val preview = ChatMessage("assistant", "末尾摘要", "long", true, 12, "body-r1")
        val first = MessageTextPage.parse(wireJson.parseToJsonElement("""{"sessionId":"s1","messageId":"long","text":"中文","offset":0,"nextOffset":6,"hasMore":true,"total":12,"revision":"body-r1"}""").jsonObject)
        val partial = applyMessagePage("s1", preview, first, 0)
        assertEquals("中文", partial.body); assertEquals(6, partial.loadedBytes)
        val last = MessageTextPage.parse(wireJson.parseToJsonElement("""{"sessionId":"s1","messageId":"long","text":"正文","offset":6,"nextOffset":null,"hasMore":false,"total":12,"revision":"body-r1"}""").jsonObject)
        val full = applyMessagePage("s1", partial, last, 6)
        assertEquals("中文正文", full.body); assertFalse(full.textTruncated); assertEquals(12, full.loadedBytes)
        assertThrows(Exception::class.java) { applyMessagePage("other", partial, last, 6) }
        assertThrows(Exception::class.java) { applyMessagePage("s1", partial.copy(revision = "changed"), last, 6) }
        assertThrows(Exception::class.java) { MessageTextPage.parse(wireJson.parseToJsonElement("""{"sessionId":"s1","messageId":"long","text":"中","offset":6,"nextOffset":8,"hasMore":true,"total":12,"revision":"r"}""").jsonObject) }
    }

    @Test fun periodicPreviewRefreshKeepsExpandedTextOnlyForTheSameMessageRevision() {
        val latest = page(6, 11).copy(messages = listOf(ChatMessage("assistant", "摘要", "m11", true, 12, "body-r1")))
        val expanded = latest.copy(messages = listOf(ChatMessage("assistant", "中文正文", "m11", false, 12, "body-r1", 12)))
        assertEquals("中文正文", mergeLatestSnapshot(latest, expanded).messages.single().body)
        val changed = latest.copy(messages = listOf(latest.messages.single().copy(revision = "body-r2")))
        assertEquals("摘要", mergeLatestSnapshot(changed, expanded).messages.single().body)
        assertEquals(0, mergeLatestSnapshot(changed, expanded).messages.single().loadedBytes)
        val projected = SessionSnapshot.parse(buildJsonObject {
            put("session", buildJsonObject { put("id", "s1") }); put("status", "idle")
            put("messages", buildJsonArray { add(buildJsonObject { put("id", "m11"); put("role", "assistant"); put("textRevision", "body-r1"); put("textTruncated", true); put("textTotal", 12)
                put("parts", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", "摘要") }) }) }) })
        })
        assertEquals("body-r1", projected.messages.single().revision)
    }
}
