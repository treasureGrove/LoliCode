package art.treasuregrove.lolicode.mobile.data

import art.treasuregrove.lolicode.mobile.protocol.*
import kotlinx.serialization.json.*

data class PairedComputer(val pairing: Pairing, val deviceId: String, val approved: Boolean = false,
    val accountId: String? = null, val desktopDeviceId: String? = null, val desktopFingerprint: String? = null) {
    val id get() = pairing.roomId
    val name get() = pairing.hostName
    fun toJson() = buildJsonObject {
        put("pairing", pairing.toJson()); put("deviceId", deviceId); put("approved", approved)
        accountId?.let { put("accountId", it) }; desktopDeviceId?.let { put("desktopDeviceId", it) }
        desktopFingerprint?.let { put("desktopFingerprint", it) }
    }
    override fun toString() = "PairedComputer(name=$name, accountId=$accountId, approved=$approved, credentials=[redacted])"
}
data class Project(val path: String, val name: String)
data class Model(val id: String, val name: String)
data class Session(val id: String, val title: String, val projectPath: String) {
    companion object {
        fun parse(value: JsonObject) = Session(value.string("id"), value.string("title").ifBlank { "新会话" }, value.string("projectPath"))
    }
}
data class ChatMessage(val role: String, val body: String)
data class Approval(val id: String, val action: String, val detail: String, val canApprove: Boolean = true)
data class Question(val id: String, val title: String, val fields: List<JsonObject>)
data class FileDiff(val path: String, val patch: String)
data class SessionSnapshot(
    val session: Session, val status: String,
    val messages: List<ChatMessage>, val approvals: List<Approval>, val questions: List<Question>,
    val diffs: List<FileDiff>, val error: String, val truncated: Boolean, val truncationMessage: String,
    val revision: String? = null,
) {
    companion object {
        fun parse(data: JsonObject): SessionSnapshot = SessionSnapshot(
            Session.parse(data.getValue("session").jsonObject), data.string("status"),
            data.array("messages").map { element ->
                val message = element.jsonObject
                ChatMessage(message.string("role"), message.array("parts").joinToString("\n") { part ->
                    val obj = part.jsonObject
                    when (obj.string("type")) {
                        "text" -> obj.string("text")
                        "reasoning" -> "思考：${obj.string("text")}"
                        "tool" -> "${obj.string("name")} · ${obj.string("state")}\n${obj.string("output")}\n${obj.string("error")}".trim()
                        else -> ""
                    }
                }.trim())
            }.filter { it.body.isNotEmpty() },
            data.array("permissions").map { element ->
                val obj = element.jsonObject
                Approval(obj.string("id"), obj.string("action"), listOf(
                    obj.string("description"), obj.string("toolName"),
                    obj.array("resources").joinToString("\n") { it.jsonPrimitive.content },
                    obj["toolInput"]?.takeUnless { it is JsonNull }?.toString().orEmpty(),
                ).filter(String::isNotBlank).joinToString("\n"), !obj.boolean("requiresDirect") && (obj["canApprove"] == null || obj.boolean("canApprove")))
            },
            data.array("questions").map { element ->
                val obj = element.jsonObject
                Question(obj.string("id"), obj.string("title"), obj.array("fields").map(JsonElement::jsonObject))
            },
            data.array("diffs").map { FileDiff(it.jsonObject.string("path"), it.jsonObject.string("patch")) },
            data.string("error"), data.boolean("truncated"), data.string("truncationMessage"), data.string("revision").ifBlank { null },
        )
    }
}

/** A revision acknowledgement must never erase the locally rendered baseline. */
fun applySnapshotResponse(data: JsonObject, previous: SessionSnapshot?, knownRevision: String?): SessionSnapshot {
    if (data.boolean("notModified")) {
        require(previous != null && knownRevision != null && previous.revision == knownRevision && data.string("revision") == knownRevision) { "会话增量基线已失效，请重新连接" }
        return previous
    }
    return SessionSnapshot.parse(data)
}
