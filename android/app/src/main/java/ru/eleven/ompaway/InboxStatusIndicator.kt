package ru.eleven.ompaway

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.view.View
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin

internal class InboxStatusIndicator(context: Context) : View(context) {
    enum class Kind { BUSY, SUCCESS, ERROR }

    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        textSize = 14 * resources.displayMetrics.scaledDensity
        strokeWidth = 2 * density
    }
    private val path = Path()
    private val current = FloatArray(64)
    private val origin = FloatArray(64)
    private val target = FloatArray(64)
    private val capsule = GradientDrawable().apply {
        setColor(RadianceUi.controlColor)
        cornerRadius = 20 * density
    }
    private var kind = Kind.BUSY
    private var label = ""
    private var previousLabel = ""
    private var labelWidth = 0f
    private var started = 0L
    private var hasShape = false
    private var morph = false
    private var color = RadianceUi.cream
    private var originColor = color
    private var animate = true

    init {
        minimumHeight = RadianceUi.dp(context, 48)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
    }

    fun show(next: Kind, text: String, description: String, animations: Boolean) {
        animate = animations
        contentDescription = description
        tooltipText = description
        if (next == kind && text == label) { invalidate(); return }
        morph = hasShape && isShown && alpha > 0f
        if (morph) current.copyInto(origin)
        originColor = color
        previousLabel = label
        label = text
        labelWidth = paint.measureText(text)
        kind = next
        if (kind != Kind.BUSY) for (i in 0..31) {
            if (kind == Kind.SUCCESS) {
                target[i * 2] = if (i <= 10) -7 + 5 * i / 10f else -2 + 10 * (i - 10) / 21f
                target[i * 2 + 1] = if (i <= 10) 5 * i / 10f else 5 - 11 * (i - 10) / 21f
            } else {
                val t = i / 31f
                target[i * 2] = when { t <= 1f/3 -> -5 + 30*t; t <= .5f -> 5 - 30*(t-1f/3); t <= 2f/3 -> 30*(t-.5f); else -> 5 - 30*(t-2f/3) }
                target[i * 2 + 1] = when { t <= 1f/3 -> -5 + 30*t; t <= .5f -> 5 - 30*(t-1f/3); t <= 2f/3 -> -30*(t-.5f); else -> -5 + 30*(t-2f/3) }
            }
        }
        started = SystemClock.uptimeMillis()
        requestLayout()
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(resolveSize(ceil(56 * density + labelWidth).toInt(), widthMeasureSpec),
            resolveSize(minimumHeight, heightMeasureSpec))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        capsule.setBounds(0, (4 * density).toInt(), w, h - (4 * density).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        val now = SystemClock.uptimeMillis()
        val elapsed = now - started
        val amount = if (animate) ease(elapsed / 480f) else 1f
        if (kind == Kind.BUSY) {
            val phase = if (animate) (now % 19_500L).toDouble() else 0.0
            val angle = phase / 1500 * Math.PI * 2 - Math.PI / 2
            val sweep = if (animate) 85 + 190 * (.5 - .5 * cos(phase / 1300 * Math.PI * 2)) else 235.0
            val step = sweep * Math.PI / 180 / 31
            val c = cos(step).toFloat(); val s = sin(step).toFloat()
            var x = 8 * cos(angle).toFloat(); var y = 8 * sin(angle).toFloat()
            for (i in 0..31) {
                target[i * 2] = x; target[i * 2 + 1] = y
                val next = x * c - y * s
                y = x * s + y * c; x = next
            }
        }
        val tint = if (kind == Kind.ERROR) 0xffe78383.toInt() else RadianceUi.cream
        color = Color.rgb(blend(Color.red(originColor), Color.red(tint), amount),
            blend(Color.green(originColor), Color.green(tint), amount), blend(Color.blue(originColor), Color.blue(tint), amount))
        capsule.draw(canvas)
        paint.style = Paint.Style.STROKE; paint.color = color; paint.alpha = 255
        path.rewind()
        val cy = height / 2f
        for (i in 0..31) {
            val index = i * 2
            current[index] = if (morph) origin[index] + (target[index] - origin[index]) * amount else target[index]
            current[index + 1] = if (morph) origin[index + 1] + (target[index + 1] - origin[index + 1]) * amount else target[index + 1]
            val x = (22 + current[index]) * density; val y = cy + current[index + 1] * density
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        hasShape = true
        canvas.drawPath(path, paint)
        paint.style = Paint.Style.FILL; paint.color = RadianceUi.cream
        val baseline = cy - (paint.ascent() + paint.descent()) / 2
        val fade = if (animate) ease(elapsed / 180f) else 1f
        if (previousLabel != label && fade < 1f) {
            paint.alpha = (255 * (1 - fade)).toInt()
            canvas.drawText(previousLabel, 42 * density, baseline - 3 * density * fade, paint)
        }
        paint.alpha = if (previousLabel == label) 255 else (255 * fade).toInt()
        canvas.drawText(label, 42 * density, baseline + 3 * density * (1 - fade), paint)
        paint.alpha = 255
        if (animate && (kind == Kind.BUSY || elapsed < 480) && windowVisibility == VISIBLE && isShown)
            postInvalidateOnAnimation()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility != VISIBLE) hasShape = false
    }

    private fun blend(from: Int, to: Int, progress: Float) = (from + (to - from) * progress).toInt()
    private fun ease(value: Float): Float { val rest = 1 - value.coerceIn(0f, 1f); return 1 - rest * rest * rest }
}
