package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import art.treasuregrove.lolicode.mobile.data.Question
import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*

@Composable
internal fun QuestionCard(question: Question, enabled: Boolean, submit: (JsonObject) -> Unit) {
    val values = remember(question.id) { mutableStateMapOf<String, String>() }
    val multi = remember(question.id) { mutableStateMapOf<String, Set<String>>() }
    var validation by remember(question.id) { mutableStateOf<String?>(null) }
    LoliCard(color = LoliColors.VioletSoft.copy(alpha = 0.55f)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GlyphTile(Glyph.Question, color = LoliColors.Violet, background = Color.White, size = 40.dp)
            Text(question.title.ifBlank { "需要你回答" }, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
        }
        question.fields.filterNot { it.boolean("hidden") }.forEach { field ->
            val key = field.string("key")
            val kind = field.string("type")
            val title = field.string("title").ifBlank { key }
            val options = field.array("options").map { it.jsonObject.string("value") to it.jsonObject.string("label") }
            val value = values[key] ?: (field["default"] as? JsonPrimitive)?.content.orEmpty()
            if (field.string("description").isNotBlank()) Text(field.string("description"), style = MaterialTheme.typography.bodySmall, color = LoliColors.Muted)
            when {
                kind == "external" -> Text("$title：需要电脑端交互，手机暂时无法代答。", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                kind == "boolean" -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(title, Modifier.weight(1f)); Switch(value.toBoolean(), { values[key] = it.toString() }, enabled = enabled) }
                kind == "multiselect" -> {
                    Text(title, fontWeight = FontWeight.Medium)
                    options.forEach { (id, name) -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).background(if (id in multi[key].orEmpty()) LoliColors.VioletSoft else Color.White.copy(alpha = 0.7f), RoundedCornerShape(13.dp)).clickable(enabled = enabled) {
                        val selected = multi[key].orEmpty(); multi[key] = if (id in selected) selected - id else selected + id
                    }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(id in multi[key].orEmpty(), { checked -> val selected = multi[key].orEmpty(); multi[key] = if (checked) selected + id else selected - id }, enabled = enabled)
                        Text(name, Modifier.weight(1f))
                    } }
                }
                options.isNotEmpty() && !field.boolean("custom") -> LoliChoice(title, options.firstOrNull { it.first == value }?.second.orEmpty(), options, enabled) { values[key] = it }
                else -> OutlinedTextField(value, { values[key] = it }, label = { Text(title) }, modifier = Modifier.fillMaxWidth(), enabled = enabled, shape = RoundedCornerShape(16.dp),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = Color.White, focusedContainerColor = Color.White, focusedBorderColor = LoliColors.Violet),
                    keyboardOptions = KeyboardOptions(keyboardType = if (kind == "number" || kind == "integer") KeyboardType.Decimal else KeyboardType.Text))
            }
        }
        validation?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = {
            runCatching {
                buildJsonObject {
                    question.fields.filterNot { it.boolean("hidden") }.forEach { field ->
                        val key = field.string("key"); val type = field.string("type")
                        val raw = values[key] ?: (field["default"] as? JsonPrimitive)?.content.orEmpty()
                        if (type == "external") return@forEach
                        if (type == "multiselect") {
                            val selected = multi[key].orEmpty()
                            require(!field.boolean("required") || selected.isNotEmpty()) { "请选择 ${field.string("title").ifBlank { key }}" }
                            put(key, JsonArray(selected.map(::text)))
                        } else {
                            require(!field.boolean("required") || raw.isNotBlank() || type == "boolean") { "请填写 ${field.string("title").ifBlank { key }}" }
                            if (raw.isBlank() && !field.boolean("required") && type != "boolean") return@forEach
                            put(key, when (type) {
                                "boolean" -> JsonPrimitive(raw.toBoolean())
                                "integer" -> JsonPrimitive(raw.toLongOrNull() ?: error("请输入整数"))
                                "number" -> JsonPrimitive(raw.toDoubleOrNull()?.takeIf { it.isFinite() } ?: error("请输入有效数字"))
                                else -> text(raw)
                            })
                        }
                    }
                }
            }.onSuccess { validation = null; submit(it) }.onFailure { validation = it.message }
        }, enabled = enabled && question.fields.none { it.string("type") == "external" && it.boolean("required") }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(17.dp), colors = ButtonDefaults.buttonColors(containerColor = LoliColors.Violet)) { Text("提交回答") }
    }
}
