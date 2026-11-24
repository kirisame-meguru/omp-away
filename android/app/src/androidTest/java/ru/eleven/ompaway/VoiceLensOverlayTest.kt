package ru.eleven.ompaway

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import com.example.radiance.LensPlacement
import com.example.radiance.OrbFallback
import com.example.radiance.OrbLayer
import com.example.radiance.OrbSurface
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.max

/** Real compositor screenshots of a fixture window only; no media, channel or pairing is opened. */
class VoiceLensOverlayTest {
    @Test fun gpuAndFallbackCoverTheHeaderWithoutMovingItOrBlockingTouches() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val preferences = ScreenPreferences(context)
        val previousAnimations = preferences.animations
        val previousQuality = preferences.quality
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        lateinit var scene: CallScreen
        lateinit var root: FrameLayout
        lateinit var panel: LinearLayout
        lateinit var header: Button
        lateinit var placement: LensPlacement
        val clicks = AtomicInteger()
        val source = object : CallVisualSource {
            override val active = true
            override val connected = true
            override fun microphoneLevel(nowMillis: Long) = 0f
            override fun playbackLevel() = 0f
        }
        var created = false
        try {
            instrumentation.runOnMainSync {
                preferences.animations = false
                preferences.quality = 1
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                scene = CallScreen(activity, null, {}, {})
                created = true
                scene.setPanelOpen(true)
                placement = CallScreen::class.java.getDeclaredField("placement").apply { isAccessible = true }
                    .get(scene) as LensPlacement
                header = Button(activity).apply {
                    text = "Fixture header"; gravity = Gravity.TOP or Gravity.START
                    setPadding(12, 12, 12, 12)
                    setTextColor(Color.BLACK); setBackgroundColor(Color.MAGENTA)
                    setOnClickListener { clicks.incrementAndGet() }
                }
                panel = LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    setBackgroundColor(Color.MAGENTA)
                    addView(header, LinearLayout.LayoutParams(-1, RadianceUi.dp(activity, 200)))
                    addView(TextView(activity).apply { text = "Fixture content" }, LinearLayout.LayoutParams(-1, 0, 1f))
                }
                root = FrameLayout(activity).apply {
                    addView(scene, FrameLayout.LayoutParams(-1, -1))
                    addView(panel, FrameLayout.LayoutParams(-1, -1))
                    (scene.voiceOverlay.parent as ViewGroup).removeView(scene.voiceOverlay)
                    addView(scene.voiceOverlay, FrameLayout.LayoutParams(-1, -1))
                }
                activity.setContentView(root)
                scene.resume()
            }
            await { activity.hasWindowFocus() && root.width > 0 && placement.restingBottom > 0f }
            val origin = IntArray(2)
            val headerPosition = IntArray(2)
            val panelPosition = IntArray(2)
            val callHeading = CallScreen::class.java.getDeclaredField("heading").apply { isAccessible = true }
            var headingMargin = 0
            var centerX = 0; var centerY = 0; var outsideX = 0
            instrumentation.runOnMainSync {
                root.getLocationOnScreen(origin)
                header.getLocationOnScreen(headerPosition)
                panel.getLocationOnScreen(panelPosition)
                headingMargin = ((callHeading.get(scene) as View).layoutParams as FrameLayout.LayoutParams).topMargin
                centerX = origin[0] + root.width / 2
                centerY = origin[1] + (placement.restingBottom - placement.baseRadius * placement.scale * .744f).toInt()
                outsideX = origin[0] + root.width / 12
                assertTrue("The voice lens must overlap the first ordinary-layout header", centerY < headerPosition[1] + header.height)
                assertSame(header, panel.getChildAt(0))
                assertEquals(root.childCount - 1, root.indexOfChild(scene.voiceOverlay))
                assertFalse(scene.voiceOverlay.isClickable)
                assertFalse(scene.voiceOverlay.isFocusable)
            }
            for (quality in listOf(1, 2)) {
                instrumentation.runOnMainSync {
                    scene.bind(null)
                    preferences.animations = false
                    preferences.quality = quality
                    scene.refreshAppearance()
                    if (quality == 1) {
                        val gpu = children(scene.voiceOverlay).filterIsInstance<OrbSurface>().single()
                        assertTrue("GPU selector must exercise the actual native foreground", gpu.isShown)
                        assertEquals(OrbLayer.LENS, gpu.layer)
                    } else assertTrue(children(scene.voiceOverlay).filterIsInstance<OrbFallback>().single().isShown)
                }
                // Establish that the actual screen, including the native surface, is transparent while idle.
                val idle = awaitPixels(centerX, centerY, outsideX) { center, outside ->
                    difference(center, Color.MAGENTA) < 8 && difference(outside, Color.MAGENTA) < 8
                }
                var backgroundClock = 0f
                lateinit var background: View
                instrumentation.runOnMainSync {
                    background = if (quality == 1) children(scene).filterIsInstance<OrbSurface>().single()
                        else children(scene).filterIsInstance<OrbFallback>().single()
                    backgroundClock = background.javaClass.getDeclaredField("elapsed").apply { isAccessible = true }.getFloat(background)
                    scene.bind(source)
                    preferences.animations = true
                    scene.refreshAppearance()
                }
                awaitPixels(centerX, centerY, outsideX) { center, outside ->
                    difference(center, idle.first) > 60 && difference(outside, idle.second) < 8
                }
                instrumentation.runOnMainSync {
                    val current = IntArray(2)
                    header.getLocationOnScreen(current)
                    assertArrayEquals("Voice must not displace the header", headerPosition, current)
                    panel.getLocationOnScreen(current)
                    assertArrayEquals("Voice must not displace the panel", panelPosition, current)
                    assertEquals(headingMargin, ((callHeading.get(scene) as View).layoutParams as FrameLayout.LayoutParams).topMargin)
                    assertEquals("The static scene must not advance with voice animation", backgroundClock,
                        background.javaClass.getDeclaredField("elapsed").apply { isAccessible = true }.getFloat(background), 0f)
                }
                val before = clicks.get()
                val now = SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, centerX.toFloat(), centerY.toFloat(), 0)
                val up = MotionEvent.obtain(now, now + 40, MotionEvent.ACTION_UP, centerX.toFloat(), centerY.toFloat(), 0)
                try { instrumentation.sendPointerSync(down); instrumentation.sendPointerSync(up) }
                finally { down.recycle(); up.recycle() }
                await { clicks.get() == before + 1 }
                instrumentation.runOnMainSync {
                    preferences.animations = false
                    scene.refreshAppearance()
                    scene.bind(null)
                }
                awaitPixels(centerX, centerY, outsideX) { center, outside ->
                    difference(center, idle.first) < 8 && difference(outside, idle.second) < 8
                }
            }
        } finally {
            instrumentation.runOnMainSync {
                if (created) scene.dispose()
                activity.finish()
                preferences.animations = previousAnimations
                preferences.quality = previousQuality
            }
        }
    }

    private fun children(view: ViewGroup) = (0 until view.childCount).map { view.getChildAt(it) }
    private fun difference(a: Int, b: Int) = max(abs(Color.red(a) - Color.red(b)),
        max(abs(Color.green(a) - Color.green(b)), abs(Color.blue(a) - Color.blue(b))))

    private fun awaitPixels(x: Int, y: Int, outsideX: Int, expected: (Int, Int) -> Boolean): Pair<Int, Int> {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = SystemClock.elapsedRealtime() + 4000
        while (SystemClock.elapsedRealtime() < deadline) {
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "Fixture screenshot unavailable" }
            val center: Int; val outside: Int
            try { center = bitmap.getPixel(x, y); outside = bitmap.getPixel(outsideX, y) }
            finally { bitmap.recycle() }
            if (expected(center, outside)) return center to outside
            SystemClock.sleep(40)
        }
        throw AssertionError("Foreground pixels did not compose over the header with transparent surroundings")
    }

    private fun await(predicate: () -> Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = SystemClock.elapsedRealtime() + 4000
        while (SystemClock.elapsedRealtime() < deadline) {
            var ready = false
            instrumentation.runOnMainSync { ready = predicate() }
            if (ready) return
            SystemClock.sleep(20)
        }
        throw AssertionError("Fixture layout or touch delivery did not settle")
    }
}
