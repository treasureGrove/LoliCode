package art.treasuregrove.lolicode.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal object LoliColors {
    val Rose = Color(0xFFBB397A)
    val RoseSoft = Color(0xFFFFE6F1)
    val Violet = Color(0xFF7656A9)
    val VioletSoft = Color(0xFFF0E8FF)
    val Blush = Color(0xFFFFF1F7)
    val SkySoft = Color(0xFFEAF6FF)
    val Background = Color(0xFFFFF9FD)
    val Ink = Color(0xFF392B46)
    val Muted = Color(0xFF75627E)
    val Line = Color(0xFFEEDFF0)
    val Green = Color(0xFF34745C)
    val GreenSoft = Color(0xFFEAF5EE)
    val Amber = Color(0xFF986017)
    val AmberSoft = Color(0xFFFFF4DF)
}

@Composable
internal fun LoliTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(
        primary = LoliColors.Rose, onPrimary = Color.White, primaryContainer = LoliColors.RoseSoft,
        secondary = LoliColors.Violet, secondaryContainer = LoliColors.VioletSoft,
        onSecondaryContainer = LoliColors.Violet, tertiary = LoliColors.Green,
        background = LoliColors.Background, surface = Color.White,
        surfaceVariant = LoliColors.Blush, onSurface = LoliColors.Ink, onBackground = LoliColors.Ink,
        outline = Color(0xFFD8C6DF), outlineVariant = LoliColors.Line,
    ), content = content)
}

/** Static ornament only: no hit targets, motion, state, or business information. */
@Composable
internal fun AnimeBackdrop(modifier: Modifier = Modifier) {
    Canvas(modifier.background(Brush.verticalGradient(listOf(LoliColors.Blush, LoliColors.Background, Color(0xFFF8F4FF))))) {
        drawCircle(LoliColors.RoseSoft.copy(alpha = 0.5f), size.width * 0.38f, Offset(size.width * 1.03f, size.height * 0.12f))
        drawCircle(LoliColors.VioletSoft.copy(alpha = 0.45f), size.width * 0.33f, Offset(-size.width * 0.13f, size.height * 0.62f))
        val decorations = listOf(0.08f to 0.13f, 0.88f to 0.29f, 0.16f to 0.42f, 0.94f to 0.59f, 0.09f to 0.77f, 0.79f to 0.91f)
        decorations.forEachIndexed { index, (x, y) ->
            val center = Offset(size.width * x, size.height * y)
            val radius = (if (index % 2 == 0) 5f else 3f).dp.toPx()
            val star = Path().apply {
                moveTo(center.x, center.y - radius)
                lineTo(center.x + radius * 0.28f, center.y - radius * 0.28f)
                lineTo(center.x + radius, center.y)
                lineTo(center.x + radius * 0.28f, center.y + radius * 0.28f)
                lineTo(center.x, center.y + radius)
                lineTo(center.x - radius * 0.28f, center.y + radius * 0.28f)
                lineTo(center.x - radius, center.y)
                lineTo(center.x - radius * 0.28f, center.y - radius * 0.28f)
                close()
            }
            drawPath(star, (if (index % 2 == 0) LoliColors.Rose else LoliColors.Violet).copy(alpha = 0.16f))
        }
    }
}

@Composable
internal fun AnimeRibbon(label: String, modifier: Modifier = Modifier, color: Color = LoliColors.Violet) {
    Surface(modifier = modifier, color = color.copy(alpha = 0.08f), contentColor = color,
        shape = RoundedCornerShape(8.dp), border = BorderStroke(1.dp, color.copy(alpha = 0.12f))) {
        Row(Modifier.padding(horizontal = 9.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            AppGlyph(Glyph.Sparkle, tint = color, size = 11.dp)
            Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
        }
    }
}

internal enum class Glyph { Workbench, Tasks, Devices, Plus, Right, Back, Refresh, Scan, Shield, Bell, Check, Close, Send, Search, File, Clock, Code, Down, Sparkle, Question }

/** Native vector icons; no font icons or downloaded assets. */
@Composable
internal fun AppGlyph(glyph: Glyph, modifier: Modifier = Modifier, tint: Color = LoliColors.Muted, size: Dp = 22.dp, description: String? = null) {
    Canvas(modifier.size(size).then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)) {
        val scaleX = this.size.width / 24f
        val scaleY = this.size.height / 24f
        withTransform({ scale(scaleX, scaleY, Offset.Zero) }) {
            val stroke = Stroke(1.7f, cap = StrokeCap.Round)
            fun line(x: Float, y: Float, xx: Float, yy: Float) = drawLine(tint, Offset(x, y), Offset(xx, yy), 1.7f, StrokeCap.Round)
            fun path(vararg points: Pair<Float, Float>) {
                drawPath(Path().apply { points.forEachIndexed { index, (x, y) -> if (index == 0) moveTo(x, y) else lineTo(x, y) } }, tint, style = stroke)
            }
            when (glyph) {
                Glyph.Workbench -> for (x in listOf(4f, 14f)) for (y in listOf(4f, 14f)) drawRoundRect(tint, Offset(x, y), Size(6f, 6f), CornerRadius(1.5f), style = stroke)
                Glyph.Tasks -> { drawRoundRect(tint, Offset(4f, 3f), Size(16f, 18f), CornerRadius(3f), style = stroke); path(7f to 9f, 8.5f to 10.5f, 11f to 7.5f); line(14f, 9f, 17f, 9f); line(8f, 15f, 17f, 15f) }
                Glyph.Devices -> { drawRoundRect(tint, Offset(3f, 4f), Size(18f, 13f), CornerRadius(2f), style = stroke); line(12f, 17f, 12f, 21f); line(8f, 21f, 16f, 21f) }
                Glyph.Plus -> { line(12f, 5f, 12f, 19f); line(5f, 12f, 19f, 12f) }
                Glyph.Right -> path(9f to 5f, 16f to 12f, 9f to 19f)
                Glyph.Back -> { path(14f to 5f, 7f to 12f, 14f to 19f); line(7f, 12f, 21f, 12f) }
                Glyph.Down -> path(6f to 9f, 12f to 15f, 18f to 9f)
                Glyph.Refresh -> { drawArc(tint, 40f, 300f, false, Offset(4f, 4f), Size(16f, 16f), style = stroke); path(20f to 3f, 20f to 9f, 14f to 9f) }
                Glyph.Scan -> { path(4f to 9f, 4f to 4f, 9f to 4f); path(15f to 4f, 20f to 4f, 20f to 9f); path(20f to 15f, 20f to 20f, 15f to 20f); path(9f to 20f, 4f to 20f, 4f to 15f); line(8f, 12f, 16f, 12f) }
                Glyph.Shield -> { path(12f to 2f, 20f to 5f, 19f to 14f, 16f to 19f, 12f to 22f, 8f to 19f, 5f to 14f, 4f to 5f, 12f to 2f); path(8f to 11f, 11f to 14f, 16f to 9f) }
                Glyph.Bell -> { path(5f to 17f, 7f to 14f, 7f to 9f, 9f to 5f, 15f to 5f, 17f to 9f, 17f to 14f, 19f to 17f, 5f to 17f); drawArc(tint, 0f, 180f, false, Offset(10f, 19f), Size(4f, 2f), style = stroke) }
                Glyph.Check -> path(5f to 12f, 10f to 17f, 20f to 6f)
                Glyph.Close -> { line(6f, 6f, 18f, 18f); line(6f, 18f, 18f, 6f) }
                Glyph.Send -> { path(4f to 11f, 20f to 4f, 13f to 20f, 10f to 13f, 4f to 11f); line(10f, 13f, 15f, 9f) }
                Glyph.Search -> { drawCircle(tint, 6.5f, Offset(10f, 10f), style = stroke); line(15f, 15f, 21f, 21f) }
                Glyph.File -> { path(5f to 3f, 14f to 3f, 19f to 8f, 19f to 21f, 5f to 21f, 5f to 3f); path(14f to 3f, 14f to 8f, 19f to 8f); line(9f, 12f, 15f, 12f); line(9f, 16f, 15f, 16f) }
                Glyph.Clock -> { drawCircle(tint, 9f, Offset(12f, 12f), style = stroke); path(12f to 6f, 12f to 12f, 16f to 14f) }
                Glyph.Code -> { path(8f to 6f, 2f to 12f, 8f to 18f); path(16f to 6f, 22f to 12f, 16f to 18f); line(14f, 3f, 10f, 21f) }
                Glyph.Sparkle -> path(12f to 2f, 15f to 9f, 22f to 12f, 15f to 15f, 12f to 22f, 9f to 15f, 2f to 12f, 9f to 9f, 12f to 2f)
                Glyph.Question -> { drawCircle(tint, 9f, Offset(12f, 12f), style = stroke); path(9f to 8f, 10f to 6f, 14f to 6f, 16f to 8f, 16f to 10f, 12f to 13f, 12f to 14f); drawCircle(tint, 0.9f, Offset(12f, 18f)) }
            }
        }
    }
}

@Composable
internal fun GlyphTile(glyph: Glyph, color: Color = LoliColors.Rose, background: Color = LoliColors.RoseSoft, size: Dp = 44.dp) {
    Surface(modifier = Modifier.size(size), shape = RoundedCornerShape(15.dp), color = background,
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.9f)), shadowElevation = 1.dp) {
        Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color.White.copy(alpha = 0.35f), Color.Transparent))), contentAlignment = Alignment.Center) { AppGlyph(glyph, tint = color) }
    }
}

@Composable
internal fun LoliCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, color: Color = Color.White, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier = modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier), shape = RoundedCornerShape(24.dp), color = color, border = BorderStroke(1.dp, LoliColors.Line), shadowElevation = 2.dp) {
        Box {
            Canvas(Modifier.matchParentSize()) {
                val corner = Offset(size.width - 18.dp.toPx(), 17.dp.toPx())
                val radius = 4.dp.toPx()
                drawLine(LoliColors.Violet.copy(alpha = 0.12f), corner - Offset(radius, 0f), corner + Offset(radius, 0f), 1.dp.toPx(), StrokeCap.Round)
                drawLine(LoliColors.Violet.copy(alpha = 0.12f), corner - Offset(0f, radius), corner + Offset(0f, radius), 1.dp.toPx(), StrokeCap.Round)
            }
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
        }
    }
}

@Composable
internal fun StatusPill(label: String, color: Color = LoliColors.Muted, background: Color = Color(0xFFF3EEF3), dot: Boolean = true) {
    Surface(color = background, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, color.copy(alpha = 0.08f))) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (dot) Box(Modifier.size(5.dp).background(color, CircleShape))
            Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
internal fun SectionHeading(title: String, action: String? = null, onAction: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(4.dp).height(18.dp).background(Brush.verticalGradient(listOf(LoliColors.Rose, LoliColors.Violet)), RoundedCornerShape(3.dp)))
        Spacer(Modifier.width(8.dp))
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (action != null) TextButton(onClick = onAction) { Text(action); Spacer(Modifier.width(4.dp)); AppGlyph(Glyph.Right, size = 14.dp, tint = LoliColors.Rose) }
    }
}

internal fun statusLabel(status: String?) = when (status) {
    "running" -> "正在运行"
    "waiting_permission" -> "等待审批"
    "waiting_question" -> "等待回答"
    "error" -> "执行异常"
    "idle" -> "已就绪"
    else -> "待同步"
}
internal fun statusColor(status: String?) = when (status) {
    "running" -> LoliColors.Rose
    "waiting_permission", "waiting_question" -> LoliColors.Amber
    "error" -> Color(0xFFB53D50)
    "idle" -> LoliColors.Green
    else -> LoliColors.Muted
}
internal fun projectName(path: String) = path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
