package com.example.radiance

import android.graphics.*
import kotlin.math.*

/** Android 10–12 and the old composite prototype; allocated only when actually used. */
internal class LegacyOrbLens(layer: OrbLayer) {
    private val lens = Path()
    private val sheet = Path()
    private val contourX = FloatArray(129) { cos(it * 2.0 * PI / 128).toFloat() }
    private val contourY = FloatArray(129) { sin(it * 2.0 * PI / 128).toFloat() }
    private var cachedShape = Float.NaN
    private val glass = LinearGradient(0f, -.74f, 0f, .74f,
        if (layer == OrbLayer.LENS) intArrayOf(0xc2080b0e.toInt(), 0xb8080b0e.toInt(), 0xaa3c3839.toInt(), 0xb8645c4b.toInt())
        else intArrayOf(Color.BLACK, Color.BLACK, 0xff3c3839.toInt(), 0xff645c4b.toInt()),
        floatArrayOf(0f,.33f,.65f,1f), Shader.TileMode.CLAMP)
    private val rim = LinearGradient(0f, -.74f, 0f, .74f,
        intArrayOf(0x223e454c,0x779798a2,0xffe2e1d5.toInt()), null, Shader.TileMode.CLAMP)
    private val spectral = arrayOf(
        LinearGradient(-.5f,-.2f,.5f,.2f,intArrayOf(0x33132dff,0xdd126aff.toInt(),0xaa96efff.toInt()),null,Shader.TileMode.CLAMP),
        LinearGradient(-.5f,-.2f,.5f,.2f,intArrayOf(0x33ff1c03,0xddff3b05.toInt(),0xaaffca69.toInt()),null,Shader.TileMode.CLAMP),
        RadialGradient(0f,0f,.6f,intArrayOf(0xccd9f6ff.toInt(),0x3384b5c0,Color.TRANSPARENT),null,Shader.TileMode.CLAMP),
    )

    fun draw(canvas: Canvas, paint: Paint, shape: Float, elapsed: Float, energy: Float, visibility: Int) {
        if (cachedShape != shape) {
            cachedShape = shape
            val power = 2f / shape
            lens.reset()
            for (i in 0..128) {
                val x = sign(contourX[i]) * abs(contourX[i]).pow(power)
                val y = sign(contourY[i]) * abs(contourY[i]).pow(power) * .744f
                if (i == 0) lens.moveTo(x,y) else lens.lineTo(x,y)
            }
            lens.close()
        }
        paint.shader = glass
        canvas.drawPath(lens, paint)
        canvas.save()
        canvas.clipPath(lens)
        val amplitude = .018f+.235f*energy
        paint.blendMode = BlendMode.PLUS
        for (layer in 0..2) {
            sheet.reset()
            val angle = elapsed*3.5f+.30f+layer*2.094395f
            for (side in 0..1) for (step in 0..48) {
                val x = if (side == 0) -1f + step / 24f else 1f - step / 24f
                val taper = max(0f, 1f - x*x)
                val y = -amplitude*taper*taper*sin(angle+x*1.65f+side*1.95f)
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
}
