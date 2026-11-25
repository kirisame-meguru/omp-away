package com.example.radiance

import android.content.Context
import android.graphics.*
import android.os.SystemClock
import android.view.View
import kotlin.math.min

/** Canvas optics without a native engine or per-frame image allocation. */
class OrbFallback(
    context: Context,
    private val shell: ShellMotion,
    private val energySource: EnergySource,
    private val placement: LensPlacement = LensPlacement(),
    val layer: OrbLayer = OrbLayer.COMPOSITE,
) : View(context) {
    var onPoseChanged: (() -> Unit)? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var background: Shader? = null
    private val optics = if (android.os.Build.VERSION.SDK_INT >= 33 && layer == OrbLayer.LENS)
        OrbOptics(context) else null
    private val legacy = if (layer != OrbLayer.SCENE && optics == null) LegacyOrbLens(layer) else null
    private var scrim: Shader? = null
    private var elapsed = .72f
    private var previous = 0L
    private var motion = false
    private var light = true
    private var mode = 1
    private var resumed = false

    init {
        isClickable = false; isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun update(animate: Boolean, light: Boolean, mode: Int) {
        if (motion == animate && this.light == light && this.mode == mode) return
        if (!motion && animate) { elapsed = 0f; previous = 0L }
        motion = animate
        this.light = light
        this.mode = mode
        invalidate()
    }
    fun resume() { resumed = true; previous = 0L; invalidate() }
    fun pause() { resumed = false; previous = 0L }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        placement.resize(w, h)
        if (layer != OrbLayer.LENS) {
            background = LinearGradient(0f,0f,w.toFloat(),h*.6f,intArrayOf(0xff46372b.toInt(),0xff777065.toInt(),0xffaaa195.toInt()),null,Shader.TileMode.CLAMP)
            scrim = LinearGradient(0f, h*.53f, 0f, h*.72f,
                intArrayOf(Color.TRANSPARENT, 0x25000000, 0x76000000, 0xc6000000.toInt(), 0xeb000000.toInt()),
                null, Shader.TileMode.CLAMP)
        }
    }

    override fun onDraw(canvas: Canvas) {
        val now = SystemClock.uptimeMillis()
        if (layer != OrbLayer.SCENE && motion && resumed && previous != 0L) {
            val dt = (now - previous).coerceIn(0,100) / 1000f
            elapsed += dt
            shell.advance(dt)
        }
        previous = now
        onPoseChanged?.invoke()
        paint.style = Paint.Style.FILL
        paint.alpha = 255
        if (layer != OrbLayer.LENS) {
            paint.shader = background
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            paint.shader = null
            paint.color = if (light) 0x00000000 else 0xbb000000.toInt()
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
        }
        val radius = placement.baseRadius
        canvas.save()
        canvas.translate(width * .5f, height * .33f)
        canvas.scale(radius, radius)
        if (layer != OrbLayer.LENS) {
            paint.color = if (light) 0xff24618c.toInt() else 0xff071b2a.toInt()
            canvas.drawRoundRect(-1.4f,.36f,-.12f,1.72f,.17f,.17f,paint)
            paint.color = if (light) 0xffd4d1c9.toInt() else 0xff242424.toInt()
            canvas.drawRoundRect(.03f,.36f,1.31f,1.72f,.17f,.17f,paint)
        }
        if (layer != OrbLayer.SCENE && shell.opacity > 0f) {
            // Background remains fixed while the lens translates, stretches and changes curvature.
            canvas.translate(0f, -placement.lift(shell))
            canvas.scale(shell.width * placement.scale, shell.height * placement.scale)
            val visibility = (255f*shell.opacity).toInt().coerceIn(0,255)
            paint.color = Color.WHITE
            paint.alpha = visibility
            val optical = optics
            if (optical != null) {
                optical.update(1f / (radius * placement.scale * min(shell.width, shell.height)),
                    elapsed, energySource.energy(elapsed, mode), shell.shape)
                paint.shader = optical.shader
                canvas.drawRect(-1.05f, -.794f, 1.05f, .794f, paint)
            } else {
                legacy?.draw(canvas, paint, shell.shape, elapsed, energySource.energy(elapsed, mode), visibility)
            }
        }
        canvas.restore()
        paint.style = Paint.Style.FILL
        paint.shader = null
        paint.alpha = 255
        if (layer != OrbLayer.LENS) {
            paint.shader = scrim
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            paint.shader = null
        }
        if (layer != OrbLayer.SCENE && motion && resumed && isShown && windowVisibility == VISIBLE && (shell.moving || shell.opacity > 0f)) {
            postInvalidateOnAnimation()
        } else previous = 0L
    }
}
