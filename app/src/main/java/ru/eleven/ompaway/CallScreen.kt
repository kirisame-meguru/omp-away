package ru.eleven.ompaway

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.Choreographer
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.example.radiance.EnergySource
import com.example.radiance.OrbFallback
import com.example.radiance.OrbSurface
import com.example.radiance.ShellMotion

/** Foreground-only call visualization. Owns no microphone, transport or audio playback. */
internal class CallScreen(
    context: Context,
    private val source: CallVisualSource,
    private val changeSpeaker: (Boolean) -> Unit,
    private val hangup: () -> Unit,
) : FrameLayout(context), EnergySource, Choreographer.FrameCallback {
    private val shell = ShellMotion()
    private val state = CallVisualState()
    private val scheduler = Choreographer.getInstance()
    private val fallback = OrbFallback(context, shell, this)
    private var flat = false
    private val surface = try {
        OrbSurface(context, {}, { useFallback() }, shell, this)
    } catch (_: RuntimeException) { null } catch (_: LinkageError) { null }
    private val title = label("Connecting audio…", 28f)
    private val caller = label("", 16f)
    private val assistant = label("", 16f)
    private val transcript = CallTranscriptViews(title, caller, assistant)
    private val speaker = Button(context)
    private val end = Button(context)
    private val motion = Button(context)
    private val controls = LinearLayout(context)
    private var speakerEnabled = false
    private var animateOverride = false
    private var resumed = false
    private var disposed = false
    private var ending = false
    private var previous = 0L
    private var lastMode = -1
    private var finishDismissal: Runnable? = null

    init {
        shell.target(4, true)
        setBackgroundColor(Color.BLACK)
        surface?.let { addView(it, LayoutParams(-1, -1)) }
        flat = surface == null
        addView(fallback, LayoutParams(-1, -1))
        fallback.visibility = if (flat) VISIBLE else INVISIBLE
        val heading = label("away", 26f).apply { setPadding(dp(24), dp(18), dp(24), 0) }
        addView(heading, LayoutParams(-1, -2, Gravity.TOP))
        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, dp(8))
            gravity = Gravity.CENTER_HORIZONTAL
        }
        title.gravity = Gravity.CENTER
        content.addView(title, LinearLayout.LayoutParams(-1, -2))
        caller.setTextColor(0xffc5bfcc.toInt())
        content.addView(caller, LinearLayout.LayoutParams(-1, -2))
        content.addView(assistant, LinearLayout.LayoutParams(-1, -2))
        controls.orientation = LinearLayout.VERTICAL
        controls.setPadding(dp(24), 0, dp(24), dp(16))
        val captions = ScrollView(context).apply { addView(content) }
        controls.addView(captions, LinearLayout.LayoutParams(-1, 0, 1f))
        val buttons = LinearLayout(context).apply { gravity = Gravity.CENTER }
        speaker.isAllCaps = false
        speaker.setOnClickListener { if (resumed && !ending) changeSpeaker(!speakerEnabled) }
        end.text = "Hang up"; end.isAllCaps = false
        end.setOnClickListener { if (resumed && !ending) hangup() }
        buttons.addView(speaker, LinearLayout.LayoutParams(0, -2, 1f))
        buttons.addView(end, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(buttons, LinearLayout.LayoutParams(-1, -2))
        motion.isAllCaps = false
        motion.setOnClickListener {
            animateOverride = !animateOverride
            updateMotionLabel()
        }
        controls.addView(motion, LinearLayout.LayoutParams(-1, -2))
        addView(controls, LayoutParams(-1, -2, Gravity.BOTTOM))
        if (Build.VERSION.SDK_INT >= 30) setOnApplyWindowInsetsListener { _, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        } else fitsSystemWindows = true
        updateMotionLabel()
        setSpeaker(false)
    }

    private fun label(value: String, size: Float) = TextView(context).apply {
        text = value; textSize = size; setTextColor(0xfff4eee4.toInt())
        setPadding(0, dp(5), 0, dp(8))
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun still() = !ValueAnimator.areAnimatorsEnabled() && !animateOverride
    private fun updateMotionLabel() {
        motion.visibility = if (ValueAnimator.areAnimatorsEnabled()) GONE else VISIBLE
        motion.text = if (animateOverride) "Voice animation on · tap to pause" else "Animate voice (system motion is off)"
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        controls.layoutParams = (controls.layoutParams as LayoutParams).apply { height = (h * .43f).toInt() }
    }

    fun setSpeaker(enabled: Boolean) {
        speakerEnabled = enabled
        speaker.text = if (enabled) "Speaker: on" else "Speaker: off"
    }

    fun captions(user: String, userFinal: Boolean, reply: String, replyFinal: Boolean) {
        transcript.update(source.connected, state.mode == 2, user, userFinal, reply, replyFinal)
    }

    override fun energy(seconds: Float, mode: Int) = state.level

    private fun useFallback() {
        if (disposed || flat) return
        flat = true
        fallback.visibility = VISIBLE
        applyPose()
    }

    private fun applyPose() {
        val reduced = still()
        shell.target(state.mode, reduced)
        surface?.update(state.mode, reduced, true, !flat, true)
        fallback.update(!reduced && flat, true, state.mode)
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!resumed || disposed) return
        val now = SystemClock.elapsedRealtime()
        val dt = if (previous == 0L) 0f else ((frameTimeNanos - previous) / 1e9f).coerceIn(0f, .1f)
        previous = frameTimeNanos
        state.update(!ending && source.active, source.connected, source.microphoneLevel(now),
            source.playbackLevel(), now, dt, still())
        if (lastMode != state.mode) {
            lastMode = state.mode
            title.text = when (state.mode) { 0 -> "Connecting audio…"; 1 -> "Listening…"; 2 -> "Speaking…"; else -> "Call ended" }
        }
        applyPose()
        scheduler.postFrameCallbackDelayed(this, if (still()) 80L else 0L)
    }

    fun resume() {
        if (disposed || resumed) return
        resumed = true; previous = 0L
        updateMotionLabel()
        scheduler.postFrameCallback(this)
        surface?.resume(); fallback.resume()
    }

    fun pause() {
        resumed = false; previous = 0L
        scheduler.removeFrameCallback(this)
        surface?.pause(); fallback.pause()
    }

    fun dismiss(finished: () -> Unit) {
        if (ending || disposed) return
        ending = true; end.isEnabled = false; speaker.isEnabled = false
        val completion = Runnable { finishDismissal = null; finished() }
        finishDismissal = completion
        postDelayed(completion, if (still()) 0 else 1000)
    }

    fun dispose() {
        if (disposed) return
        pause(); disposed = true
        finishDismissal?.let { removeCallbacks(it) }; finishDismissal = null
        surface?.dispose()
    }
}
