package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ModelCatalogueTest {
    private val models = (0 until 45).map { Model("provider-public:model-$it-abcdefghijklmnop", "公开模型$it：" + "中文说明".repeat(8)) }
    private fun rows(values: List<Model>) = buildJsonArray { values.forEach { add(buildJsonObject { put("id", it.id); put("name", it.name) }) } }
    private fun page(offset: Int, all: List<Model> = models, generation: String = "catalog-one", count: Int = 7): JsonObject {
        val selected = all.drop(offset).take(count)
        val next = offset + selected.size
        return buildJsonObject {
            put("models", rows(selected)); put("offset", offset); put("total", all.size)
            put("hasMore", next < all.size); put("nextOffset", if (next < all.size) JsonPrimitive(next) else JsonNull)
            put("revision", "page-$offset"); put("catalogRevision", generation)
        }
    }

    @Test fun fortyFiveModelsLargerThanOneTextFrameAreFullyMergedUsingActualOffsets() = runBlocking {
        assertTrue(rows(models).toString().toByteArray(Charsets.UTF_8).size > 4000)
        val offsets = mutableListOf<Int>()
        val result = loadModelCatalogue("registered-project") { params ->
            assertEquals("registered-project", params.string("projectPath"))
            val offset = (params["offset"] as? JsonPrimitive)?.intOrNull ?: 0
            if (offset == 0) { assertFalse("offset" in params); assertFalse("limit" in params) } else assertEquals(12L, params.long("limit"))
            offsets.add(offset)
            page(offset).also { assertTrue(it.toString().toByteArray(Charsets.UTF_8).size <= 4000) }
        }
        assertEquals(listOf(0, 7, 14, 21, 28, 35, 42), offsets)
        assertEquals(models, result)
        assertEquals(45, result.map { it.id }.distinct().size)
    }

    @Test fun failedLaterPageDoesNotReturnOrPublishAnIncompleteCatalogue() = runBlocking {
        var published: List<Model>? = null
        var calls = 0
        try {
            published = loadModelCatalogue("p") { params ->
                calls++
                val offset = (params["offset"] as? JsonPrimitive)?.intOrNull ?: 0
                if (offset >= 14) throw IOException("synthetic page unavailable")
                page(offset)
            }
            fail("later page failure must remain visible")
        } catch (_: IOException) { }
        assertNull(published); assertEquals(3, calls)
    }

    @Test fun changedCatalogueTotalOrDuplicateIdsCannotBeMixedAcrossPages() = runBlocking {
        suspend fun rejects(fetch: suspend (JsonObject) -> JsonObject) {
            try { loadModelCatalogue("p", fetch); fail("inconsistent model pages must fail") }
            catch (_: IllegalArgumentException) { }
        }
        rejects { params -> val offset = (params["offset"] as? JsonPrimitive)?.intOrNull ?: 0; page(offset, generation = if (offset == 0) "one" else "two") }
        rejects { params -> val offset = (params["offset"] as? JsonPrimitive)?.intOrNull ?: 0; page(offset, all = if (offset == 0) models else models + Model("new", "new")) }
        rejects { params ->
            val offset = (params["offset"] as? JsonPrimitive)?.intOrNull ?: 0
            if (offset == 0) page(0) else page(offset, all = models.toMutableList().apply { this[offset] = models.first() })
        }
    }

    @Test fun noProgressAndOversizedCataloguesFailWithinTheBound() = runBlocking {
        for (bad in listOf(
            buildJsonObject { put("models", JsonArray(emptyList())); put("offset", 0); put("total", 45); put("hasMore", true); put("nextOffset", 0); put("catalogRevision", "one") },
            buildJsonObject { put("models", rows(models)); put("offset", 0); put("total", 20_001); put("hasMore", true); put("nextOffset", 45); put("catalogRevision", "one") },
        )) {
            try { loadModelCatalogue("p") { bad }; fail("malformed model page must fail") }
            catch (_: IllegalArgumentException) { }
        }
    }


    @Test fun completeCataloguesAboveOldCountAndNodeLimitsFitOneLogicalObject() = runBlocking {
        for (count in listOf(257, 1000)) {
            val complete = (0 until count).map { Model("model-$it", "模型$it") }
            val response = buildJsonObject {
                put("type", "response"); put("requestId", "10000000-0000-4000-8000-000000000001")
                put("result", buildJsonObject { put("models", rows(complete)) })
            }
            assertTrue(response.toString().toByteArray(Charsets.UTF_8).size <= LogicalJson.MAX_BYTES)
            val receiver = LogicalJson.Receiver(); var decoded: JsonObject? = null
            LogicalJson.encode(response).frames.forEach { decoded = receiver.ingest(it).message }
            val result = loadModelCatalogue("p") { params ->
                assertFalse("offset" in params); assertFalse("limit" in params)
                decoded!!.getValue("result").jsonObject
            }
            assertEquals(count, result.size); assertEquals(complete, result)
        }
    }

    @Test fun olderDirectCompleteCatalogueRemainsCompatible() = runBlocking {
        val result = loadModelCatalogue("p") { buildJsonObject { put("models", rows(models)) } }
        assertEquals(models, result)
    }
}
