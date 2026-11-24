package com.example.radiance

import android.content.Context
import android.graphics.*
import android.os.SystemClock
import android.view.View
import kotlin.math.*

/** Lower-cost approximation; no native engine, image allocation, or blur during drawing. */
class OrbFallback(
    context: Context,
    private val shell: ShellMotion,
    private val energySource: EnergySource,
    private val placement: LensPlacement = LensPlacement(),
    val layer: OrbLayer = OrbLayer.COMPOSITE,
) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val lens = Path()
    private val sheet = Path()
    private val contourX = FloatArray(129) { cos(it * 2.0 * PI / 128).toFloat() }
    private val contourY = FloatArray(129) { sin(it * 2.0 * PI / 128).toFloat() }
    private var cachedShape = Float.NaN
    private var background: Shader? = null
    private var glass: Shader? = null
    private var rim: Shader? = null
    private var scrim: Shader? = null
    private val spectral = arrayOf(
        LinearGradient(-.5f,-.2f,.5f,.2f,intArrayOf(0x33132dff,0xdd126aff.toInt(),0xaa96efff.toInt()),null,Shader.TileMode.CLAMP),
        LinearGradient(-.5f,-.2f,.5f,.2f,intArrayOf(0x33ff1c03,0xddff3b05.toInt(),0xaaffca69.toInt()),null,Shader.TileMode.CLAMP),
        RadialGradient(0f,0f,.6f,intArrayOf(0xccd9f6ff.toInt(),0x3384b5c0,Color.TRANSPARENT),null,Shader.TileMode.CLAMP),
    )
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
        background = LinearGradient(0f,0f,w.toFloat(),h*.6f,intArrayOf(0xff46372b.toInt(),0xff777065.toInt(),0xffaaa195.toInt()),null,Shader.TileMode.CLAMP)
        glass = LinearGradient(0f, -.74f, 0f, .74f, intArrayOf(Color.BLACK, Color.BLACK, 0xff3c3839.toInt(), 0xff645c4b.toInt()), floatArrayOf(0f,.33f,.65f,1f), Shader.TileMode.CLAMP)
        rim = LinearGradient(0f, -.74f, 0f, .74f, intArrayOf(0x223e454c,0x779798a2,0xffe2e1d5.toInt()), null, Shader.TileMode.CLAMP)
        scrim = LinearGradient(0f, h*.53f, 0f, h*.72f,
            intArrayOf(Color.TRANSPARENT, 0x25000000, 0x76000000, 0xc6000000.toInt(), 0xeb000000.toInt()),
            null, Shader.TileMode.CLAMP)
    }

    private fun updateLens() {
        if (cachedShape == shell.shape) return
        cachedShape = shell.shape
        val power = 2f / cachedShape
        lens.reset()
        for (i in 0..128) {
            val x = sign(contourX[i]) * abs(contourX[i]).pow(power)
            val y = sign(contourY[i]) * abs(contourY[i]).pow(power) * .744f
            if (i == 0) lens.moveTo(x,y) else lens.lineTo(x,y)
        }
        lens.close()
    }

    override fun onDraw(canvas: Canvas) {
        val now = SystemClock.uptimeMillis()
        if (layer != OrbLayer.SCENE && motion && resumed && previous != 0L) {
            val dt = (now - previous).coerceIn(0,100) / 1000f
            elapsed += dt
            shell.advance(dt)
        }
        previous = now
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
            updateLens()
            // Background remains fixed while the lens translates, stretches and changes curvature.
            canvas.translate(0f, -placement.lift(shell))
            canvas.scale(shell.width * placement.scale, shell.height * placement.scale)
            val visibility = (255f*shell.opacity).toInt().coerceIn(0,255)
            paint.color = Color.WHITE
            paint.alpha = visibility
            paint.shader = glass
            canvas.drawPath(lens, paint)
            canvas.save()
            canvas.clipPath(lens)
            val energy = energySource.energy(elapsed, mode)
            val amplitude = .018f+.235f*energy
            paint.blendMode = BlendMode.PLUS
            for (layer in 0..2) {
                sheet.reset()
                val angle = elapsed*3.5f+.30f+layer*2.094395f
                for (side in 0..1) for (step in 0..48) {
                    val x = if (side == 0) -1f + step / 24f else 1f - step / 24f
                    val taper = max(0f, 1f - x*x)
                    val envelope = taper*taper
                    val y = -amplitude*envelope*sin(angle+x*1.65f+side*1.95f)
                    if (side == 0 && step == 0) sheet.moveTo(x,y) else sheet.lineTo(x,y)
                }
                sheet.close()
                paint.shader = spectral[layer]
                paint.alpha = (if (layer == 2) 160 else 210) * visibility / 255
                canvas.drawPath(sheet, paint)
            }
            paint.alpha = visibility
            paint.blendMode = null
            canvas.restore()
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = .004f
            paint.shader = rim
            canvas.drawPath(lens, paint)
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
