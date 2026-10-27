package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*

/** Fetch a complete, stable model catalogue; callers publish only the returned full list. */
suspend fun loadModelCatalogue(projectPath: String, fetch: suspend (JsonObject) -> JsonObject): List<Model> {
    val models = ArrayList<Model>()
    val ids = hashSetOf<String>()
    var offset = 0
    var total: Int? = null
    var generation: String? = null
    var bytes = 0
    repeat(20_000) {
        val page = fetch(buildJsonObject { put("projectPath", projectPath); if (offset > 0) { put("offset", offset); put("limit", 12) } })
        bytes += page.toString().toByteArray(Charsets.UTF_8).size
        require(bytes <= LogicalJson.MAX_BYTES) { "模型目录超过手机预算，请在电脑精简启用模型" }
        val rows = page.array("models").map { item ->
            val row = item.jsonObject
            require(row.string("id").isNotBlank() && row.string("name").isNotBlank()) { "电脑返回的模型资料无效" }
            Model(row.string("id"), row.string("name"))
        }
        // Older direct hosts returned one complete models array with no paging fields.
        if (page["offset"] == null && page["hasMore"] == null && page["catalogRevision"] == null) {
            require(offset == 0 && rows.size <= 20_000 && rows.map { it.id }.distinct().size == rows.size) { "旧版模型目录无效或超过手机预算" }
            return rows
        }
        val actualOffset = (page["offset"] as? JsonPrimitive)?.intOrNull ?: error("模型目录页位置无效")
        val actualTotal = (page["total"] as? JsonPrimitive)?.intOrNull ?: error("模型目录总数无效")
        val actualGeneration = page.string("catalogRevision")
        require(actualOffset == offset && actualTotal in 0..20_000 && actualGeneration.isNotBlank()) { "模型目录分页无效或超过手机预算" }
        if (total == null) { total = actualTotal; generation = actualGeneration }
        require(total == actualTotal && generation == actualGeneration) { "电脑模型目录已更新，请重新加载" }
        require(rows.all { ids.add(it.id) } && models.size + rows.size <= actualTotal) { "模型目录存在重复或数量不一致" }
        models.addAll(rows)
        if (!page.boolean("hasMore")) {
            require(models.size == actualTotal && page["nextOffset"] in listOf(null, JsonNull)) { "模型目录未完整加载" }
            return models
        }
        val next = (page["nextOffset"] as? JsonPrimitive)?.intOrNull ?: error("模型目录下一页位置无效")
        require(rows.isNotEmpty() && next == offset + rows.size && next < actualTotal) { "模型目录分页没有前进" }
        offset = next
    }
    error("模型目录分页未完整完成，请重新加载")
}
