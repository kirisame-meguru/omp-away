package ru.eleven.ompaway

import android.app.Activity
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.min

class RefractiveContentTest {
    @Test fun curvedEdgeSamplesDisplacedLiveContentAndDismissalRestoresIt() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(context.packageName.endsWith(".integration"))
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        lateinit var layer: RefractiveContent
        lateinit var pattern: View
        var rightColor = Color.BLUE
        var x = 0; var y = 0; var outside = 0
        try {
            instrumentation.runOnMainSync {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                pattern = object : View(activity) {
                    private val paint = Paint()
                    override fun onDraw(canvas: Canvas) {
                        canvas.drawColor(rightColor)
                        paint.color = Color.GREEN
                        val radius = min(width, height) * .4f
                        canvas.drawRect(0f, 0f, width * .5f + radius * .95f, height.toFloat(), paint)
                    }
                }
                layer = RefractiveContent(activity).apply { addView(pattern, FrameLayout.LayoutParams(-1, -1)) }
                activity.setContentView(layer)
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTrue(layer.width > 0 && layer.height > 0)
                val origin = IntArray(2)
                layer.getLocationOnScreen(origin)
                val radius = min(layer.width, layer.height) * .4f
                // The curved edge maps local x=0.85 beyond x=0.95.
                // A real source boundary must move, not merely change opacity.
                x = origin[0] + (layer.width * .5f + radius * .85f).toInt()
                y = origin[1] + (layer.height * .33f + radius * .25f).toInt()
                outside = origin[0] + (layer.width * .5f + radius * 1.10f).toInt()
            }
            fun expect(color: Int) {
                val deadline = SystemClock.elapsedRealtime() + 4000
                while (SystemClock.elapsedRealtime() < deadline) {
                    val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                    val inside = image.getPixel(x, y)
                    val untouched = image.getPixel(outside, y)
                    image.recycle()
                    fun close(a: Int, b: Int) = abs(Color.red(a) - Color.red(b)) < 8 &&
                        abs(Color.green(a) - Color.green(b)) < 8 && abs(Color.blue(a) - Color.blue(b)) < 8
                    if (close(inside, color) && close(untouched, rightColor)) return
                    SystemClock.sleep(40)
                }
                throw AssertionError("Expected displaced live content inside the lens and unchanged pixels outside")
            }
            expect(Color.GREEN)
            instrumentation.runOnMainSync { layer.lens(layer.width, layer.height, 1f, 1f, 0f, 1f, 2.4f) }
            expect(Color.BLUE)
            instrumentation.runOnMainSync { rightColor = Color.RED; pattern.invalidate() }
            expect(Color.RED)
            instrumentation.runOnMainSync { layer.lens(layer.width, layer.height, 1f, 1f, 0f, 0f, 2.4f) }
            expect(Color.GREEN)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
    }
}
