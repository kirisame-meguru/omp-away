package ru.eleven.ompaway

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.test.platform.app.InstrumentationRegistry
import com.example.radiance.EnergySource
import com.example.radiance.LensPlacement
import com.example.radiance.OrbFallback
import com.example.radiance.OrbLayer
import com.example.radiance.OrbSurface
import com.example.radiance.ShellMotion
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** Opt-in visual experiment. Reference media stays app-private and is never bundled. */
class OrbReferenceFramesTest {
    @Test fun captureNativeTimestampFrames() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("orbReferenceFrames") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(BuildConfig.ISOLATED_INTEGRATION && context.packageName.endsWith(".integration"))
        val folder = File(context.filesDir, "orb-reference")
        val config = JSONObject(File(folder, "frames.json").readText())
        val frames = config.getJSONArray("frames")
        val run = args.getString("orbReferenceRun") ?: "comparison"
        require(Regex("[A-Za-z0-9_-]{1,48}").matches(run))
        val output = File(folder, run).apply { mkdirs() }
        val backdrop = checkNotNull(BitmapFactory.decodeFile(File(folder, "background.png").path))
        val width = backdrop.width
        val height = 1000
        val captureHeight = config.optInt("captureHeight", backdrop.height)
        require(captureHeight in 1..minOf(height, backdrop.height))
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        var gpu: OrbSurface? = null
        var fallback: OrbFallback? = null
        try {
            for (renderer in listOf("gpu", "canvas")) {
                val shell = ShellMotion().apply { target(1, true) }
                val placement = LensPlacement()
                var level = 0f
                val submissions = AtomicInteger()
                val energy = object : EnergySource {
                    override fun energy(seconds: Float, mode: Int) = level
                }
                lateinit var stage: FrameLayout
                lateinit var underlay: RefractiveContent
                lateinit var foreground: View
                instrumentation.runOnMainSync {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    underlay = RefractiveContent(activity).apply {
                        addView(ImageView(activity).apply {
                            scaleType = ImageView.ScaleType.FIT_XY
                            setImageBitmap(backdrop)
                        }, FrameLayout.LayoutParams(width, backdrop.height))
                    }
                    foreground = if (renderer == "gpu") {
                        OrbSurface(activity, { if (it.startsWith("Still frame")) submissions.incrementAndGet() },
                            { error("Reference GPU must not silently switch renderer") },
                            shell, energy, placement, OrbLayer.LENS).also {
                            gpu = it
                            it.update(1, true, true, true, false)
                            it.resume()
                        }
                    } else {
                        OrbFallback(activity, shell, energy, placement, OrbLayer.LENS).also {
                            fallback = it
                            it.update(false, true, 1)
                            it.resume()
                        }
                    }
                    stage = FrameLayout(activity).apply {
                        addView(underlay, FrameLayout.LayoutParams(-1, -1))
                        addView(foreground, FrameLayout.LayoutParams(-1, -1))
                    }
                    activity.setContentView(FrameLayout(activity).apply {
                        addView(stage, FrameLayout.LayoutParams(width, height, Gravity.CENTER))
                    })
                }
                instrumentation.waitForIdleSync()
                SystemClock.sleep(120)
                val origin = IntArray(2)
                instrumentation.runOnMainSync {
                    check(stage.width == width && stage.height == height && activity.hasWindowFocus())
                    stage.getLocationOnScreen(origin)
                    placement.resize(width, height)
                    // Calibration changes only the fixture's camera framing, never the shader.
                    LensPlacement::class.java.getDeclaredField("scale").apply { isAccessible = true }
                        .setFloat(placement, config.getDouble("radius").toFloat() / placement.baseRadius)
                    LensPlacement::class.java.getDeclaredField("anchorLift").apply { isAccessible = true }
                        .setFloat(placement, (height * .33f - config.getDouble("centerY").toFloat()) / placement.baseRadius)
                    underlay.lens(width, height, placement.scale, placement.scale, placement.lift(shell), 1f, shell.shape)
                }
                val clock = foreground.javaClass.getDeclaredField("elapsed").apply { isAccessible = true }
                for (index in 0 until frames.length()) {
                    val frame = frames.getJSONObject(index)
                    var expectedSubmission = 0
                    instrumentation.runOnMainSync {
                        expectedSubmission = submissions.get() + 1
                        level = frame.getDouble("energy").toFloat()
                        clock.setFloat(foreground, frame.getDouble("time").toFloat())
                        if (foreground is OrbSurface) (foreground as OrbSurface).refreshPlacement()
                        else foreground.invalidate()
                    }
                    if (foreground is OrbSurface) {
                        val deadline = SystemClock.elapsedRealtime() + 5000
                        while (submissions.get() < expectedSubmission && SystemClock.elapsedRealtime() < deadline)
                            SystemClock.sleep(10)
                        check(submissions.get() >= expectedSubmission) { "Requested native frame was not submitted" }
                    }
                    // Each requested shader timestamp is rendered by the physical compositor.
                    // Waiting two refresh intervals prevents capturing the preceding swapchain frame.
                    SystemClock.sleep(45)
                    instrumentation.waitForIdleSync()
                    val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                    try {
                        val crop = Bitmap.createBitmap(image, origin[0], origin[1], width, captureHeight)
                        try {
                            val name = "$renderer-${frame.getInt("frame").toString().padStart(4, '0')}.png"
                            File(output, name).outputStream().use { check(crop.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                        } finally { crop.recycle() }
                    } finally { image.recycle() }
                }
                instrumentation.runOnMainSync {
                    gpu?.dispose(); gpu = null
                    fallback?.pause(); fallback = null
                }
            }
            File(output, "frames.json").writeText(config.toString())
        } finally {
            instrumentation.runOnMainSync {
                gpu?.dispose(); fallback?.pause(); activity.finish()
            }
            backdrop.recycle()
        }
    }
}
