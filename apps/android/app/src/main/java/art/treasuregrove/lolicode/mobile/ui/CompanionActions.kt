package art.treasuregrove.lolicode.mobile.ui

import kotlinx.serialization.json.JsonObject

/** Screen events, supplied by the route. Defaults make offline previews inert. */
data class CompanionActions(
    val enrollmentVisibility: (Boolean) -> Unit = {},
    val login: (String, String) -> Unit = { _, _ -> },
    val logout: () -> Unit = {},
    val discoverComputers: () -> Unit = {},
    val requestConnection: (String) -> Unit = {},
    val pair: (String) -> Unit = {},
    val scan: () -> Unit = {},
    val selectComputer: (String) -> Unit = {},
    val forgetComputer: (String) -> Unit = {},
    val reconnect: () -> Unit = {},
    val selectProject: (String) -> Unit = {},
    val selectModel: (String) -> Unit = {},
    val selectSession: (String) -> Unit = {},
    val createSession: () -> Unit = {},
    val refresh: () -> Unit = {},
    val clearError: () -> Unit = {},
    val replyPermission: (String, Boolean) -> Unit = { _, _ -> },
    val replyQuestion: (String, JsonObject) -> Unit = { _, _ -> },
    val sendMessage: (String, () -> Unit) -> Unit = { _, _ -> },
    val cancel: () -> Unit = {},
    val requestNotifications: () -> Unit = {},
)
