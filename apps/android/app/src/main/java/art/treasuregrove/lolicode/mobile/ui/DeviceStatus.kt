package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.runtime.Composable
import art.treasuregrove.lolicode.mobile.CompanionState
import art.treasuregrove.lolicode.mobile.data.DevicePresence
import art.treasuregrove.lolicode.mobile.data.PairedComputer

internal fun deviceStatusText(presence: DevicePresence, direct: Boolean, verified: Boolean, approved: Boolean = true, limitedText: Boolean = false): String {
    val heartbeat = when (presence) {
        DevicePresence.Online -> "在线"
        DevicePresence.Offline -> "离线"
        DevicePresence.Unknown -> "状态待确认"
    }
    val connection = when {
        !approved -> "待电脑授权"
        limitedText && verified -> "受限文本"
        limitedText -> "文本验证中"
        direct && verified -> "已直连"
        direct -> "直连验证中"
        else -> "未直连"
    }
    return "$heartbeat · $connection"
}

@Composable
internal fun ComputerStatusPill(state: CompanionState, computer: PairedComputer? = state.computer) {
    if (computer == null) {
        StatusPill(if (state.account == null) "未登录" else "尚未选择电脑", LoliColors.Muted, LoliColors.VioletSoft, dot = false)
        return
    }
    val presence = state.presence(computer)
    val selected = state.selectedRoom == computer.id
    StatusPill(deviceStatusText(presence, selected && state.transport == "direct", selected && state.hostVerified, computer.approved, selected && state.transport == "text"),
        if (presence == DevicePresence.Online) LoliColors.Green else LoliColors.Muted,
        if (presence == DevicePresence.Online) LoliColors.GreenSoft else LoliColors.VioletSoft,
        dot = presence == DevicePresence.Online)
}
