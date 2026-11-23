package ru.eleven.ompaway

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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

/** Persistent Radiance scene for home and live calls. Never opens audio by itself. */
internal class CallScreen(
    context: Context,
    private var source: CallVisualSource?,
    private val changeSpeaker: (Boolean) -> Unit,
    private val hangup: () -> Unit,
    private val openInbox: () -> Unit = {},
    private val openSettings: () -> Unit = {},
) : FrameLayout(context), EnergySource, Choreographer.FrameCallback {
    private val shell = ShellMotion()
    private val state = CallVisualState()
    private val scheduler = Choreographer.getInstance()
    private val preferences = ScreenPreferences(context)
    private val qualityStatus = label("Native lens", 10f)
    private val fallback = OrbFallback(context, shell, this)
    private var autoFlat = false
    private var quality = preferences.quality
    private var light = preferences.lightBackdrop
    private var reducedMotion = preferences.reducedMotion
    private var systemMotion = ValueAnimator.areAnimatorsEnabled()
    private val surface = try {
        OrbSurface(context, { qualityStatus.text = it }, { useFallback() }, shell, this)
    } catch (_: RuntimeException) { null } catch (_: LinkageError) { null }
    private val flat get() = surface == null || quality == 2 || (quality == 0 && autoFlat)
    private val title = label("Your desktop, in reach.", 30f)
    private val callNotice = label("Voice captions · Not a submitted answer", 12f)
    private val caller = label("", 16f)
    private val assistant = label("", 16f)
    private val transcript = CallTranscriptViews(title, caller, assistant)
    private val speaker = Button(context)
    private val end = Button(context)
    private val motion = Button(context)
    private val controls = LinearLayout(context)
    private val content = LinearLayout(context)
    private val callActions = LinearLayout(context)
    private val homeActions = LinearLayout(context)
    private val homeAction = Button(context)
    private var speakerEnabled = false
    private var animateOverride = preferences.animateOverride
    private var resumed = false
    private var disposed = false
    private var ending = false
    private var previous = 0L
    private var lastMode = -1
    private var finishDismissal: Runnable? = null

    init {
        shell.target(if (source == null) 1 else 4, true)
        setBackgroundColor(Color.BLACK)
        surface?.let { addView(it, LayoutParams(-1, -1)) }
        addView(fallback, LayoutParams(-1, -1))
        fallback.visibility = if (flat) VISIBLE else INVISIBLE
        val heading = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(12), dp(16), 0)
        }
        heading.addView(label("away", 26f), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(label("R A D I A N C E", 11f).apply { setTextColor(0xffc5bfcc.toInt()) })
        heading.addView(Button(context).apply {
            styleButton(this); text = "Settings"
            setOnClickListener { if (resumed) openSettings() }
        })
        addView(heading, LayoutParams(-1, -2, Gravity.TOP))
        content.orientation = LinearLayout.VERTICAL
        content.setPadding(0, dp(10), 0, dp(8))
        content.gravity = Gravity.CENTER_HORIZONTAL
        title.gravity = Gravity.CENTER
        title.typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
        content.addView(title, LinearLayout.LayoutParams(-1, -2))
        callNotice.gravity = Gravity.CENTER
        callNotice.setTextColor(0xffc5bfcc.toInt())
        content.addView(callNotice, LinearLayout.LayoutParams(-1, -2))
        caller.setTextColor(0xffc5bfcc.toInt())
        content.addView(caller, LinearLayout.LayoutParams(-1, -2))
        assistant.setTextColor(0xffc5bfcc.toInt())
        content.addView(assistant, LinearLayout.LayoutParams(-1, -2))
        controls.orientation = LinearLayout.VERTICAL
        controls.setPadding(dp(24), 0, dp(24), dp(16))
        val captions = ScrollView(context).apply { isFillViewport = true; addView(content) }
        controls.addView(captions, LinearLayout.LayoutParams(-1, 0, 1f))
        callActions.gravity = Gravity.CENTER
        homeActions.gravity = Gravity.CENTER
        for (row in arrayOf(callActions, homeActions)) {
            row.background = GradientDrawable().apply {
                setColor(0xcc1c1c2b.toInt()); cornerRadius = dp(26).toFloat()
            }
            row.setPadding(dp(6), dp(4), dp(6), dp(4))
        }
        styleButton(speaker)
        speaker.setOnClickListener { if (resumed && !ending) changeSpeaker(!speakerEnabled) }
        styleButton(end)
        end.text = "Hang up"; end.setTextColor(0xffe9898f.toInt())
        end.setOnClickListener { if (resumed && !ending) hangup() }
        callActions.addView(speaker, LinearLayout.LayoutParams(0, -2, 1f))
        callActions.addView(Button(context).apply {
            styleButton(this); text = "Details"
            contentDescription = "View question and proposed answer"
            setOnClickListener { if (resumed && !ending) openInbox() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        callActions.addView(end, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(callActions, LinearLayout.LayoutParams(-1, -2))
        styleButton(homeAction)
        homeAction.setOnClickListener { if (resumed) openInbox() }
        homeActions.addView(homeAction, LinearLayout.LayoutParams(0, -2, 1f))
        homeActions.addView(Button(context).apply {
            styleButton(this); text = "Inbox"
            setOnClickListener { if (resumed) openInbox() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(homeActions, LinearLayout.LayoutParams(-1, -2))
        styleButton(motion)
        motion.setOnClickListener {
            preferences.animateOverride = !animateOverride
            refreshAppearance()
        }
        controls.addView(motion, LinearLayout.LayoutParams(-1, -2))
        qualityStatus.gravity = Gravity.CENTER
        qualityStatus.setTextColor(0xffc5bfcc.toInt())
        controls.addView(qualityStatus, LinearLayout.LayoutParams(-1, -2))
        addView(controls, LayoutParams(-1, -2, Gravity.BOTTOM))
        if (Build.VERSION.SDK_INT >= 30) setOnApplyWindowInsetsListener { _, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        } else fitsSystemWindows = true
        showActions()
        refreshAppearance()
        setSpeaker(false)
    }

    private fun styleButton(button: Button) {
        button.isAllCaps = false
        button.setTextColor(0xfff4eee4.toInt())
        button.setBackgroundColor(Color.TRANSPARENT)
        button.minHeight = dp(48)
        button.minimumHeight = dp(48)
    }

    private fun showActions() {
        callActions.visibility = if (source == null) GONE else VISIBLE
        homeActions.visibility = if (source == null) VISIBLE else GONE
        callNotice.visibility = if (source == null) GONE else VISIBLE
        content.gravity = Gravity.CENTER_HORIZONTAL or if (source == null) Gravity.BOTTOM else Gravity.TOP
    }

    fun bind(next: CallVisualSource?) {
        if (source === next) return
        finishDismissal?.let { removeCallbacks(it) }; finishDismissal = null
        source = next; ending = false; previous = 0L; lastMode = -1
        end.isEnabled = true; speaker.isEnabled = true
        state.update(false, false, 0f, 0f, 0L, 0f, true)
        caller.text = ""; assistant.text = ""
        caller.visibility = GONE; assistant.visibility = GONE
        showActions()
        applyPose()
        if (resumed) {
            scheduler.removeFrameCallback(this)
            scheduler.postFrameCallback(this)
        }
    }

    fun home(paired: Boolean, pending: Int, status: String) {
        if (source != null) return
        title.text = if (!paired) "Your desktop, in reach." else if (pending > 0) "Your desktop is calling." else "Ready when you are."
        caller.visibility = GONE
        assistant.visibility = VISIBLE
        assistant.gravity = Gravity.CENTER
        assistant.text = if (!paired) "Pair your desktop to answer requests by voice." else status
        homeAction.text = if (!paired) "Pair desktop" else "Requests · $pending"
    }

    fun refreshAppearance() {
        val nextQuality = preferences.quality
        if (nextQuality != quality) autoFlat = false
        quality = nextQuality; light = preferences.lightBackdrop
        reducedMotion = preferences.reducedMotion
        animateOverride = preferences.animateOverride
        systemMotion = ValueAnimator.areAnimatorsEnabled()
        updateMotionLabel()
        applyPose()
    }

    private fun label(value: String, size: Float) = TextView(context).apply {
        text = value; textSize = size; setTextColor(0xfff4eee4.toInt())
        setPadding(0, dp(5), 0, dp(8))
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun still() = reducedMotion || (!systemMotion && !animateOverride)
    private fun updateMotionLabel() {
        motion.visibility = if (systemMotion || reducedMotion) GONE else VISIBLE
        motion.text = if (animateOverride) "Voice animation on · tap to pause" else "Animate voice (system motion is off)"
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        controls.layoutParams = (controls.layoutParams as LayoutParams).apply {
            height = (h * if (w > h) .55f else .43f).toInt().coerceAtLeast(dp(190)).coerceAtMost(h)
        }
    }

    fun setSpeaker(enabled: Boolean) {
        speakerEnabled = enabled
        speaker.text = if (enabled) "Speaker: on" else "Speaker: off"
    }

    fun captions(user: String, userFinal: Boolean, reply: String, replyFinal: Boolean) {
        val current = source ?: return
        assistant.gravity = Gravity.START
        transcript.update(current.connected, state.mode == 2, user, userFinal, reply, replyFinal)
    }

    override fun energy(seconds: Float, mode: Int) = if (source == null) 0f else state.level

    private fun useFallback() {
        if (disposed || autoFlat) return
        autoFlat = true
        applyPose()
    }

    private fun applyPose() {
        val reduced = still()
        val mode = if (source == null) 1 else state.mode
        shell.target(mode, reduced)
        fallback.visibility = if (flat) VISIBLE else INVISIBLE
        surface?.update(mode, reduced, light, !flat, quality == 0)
        fallback.update(!reduced && flat, light, mode)
        if (flat) {
            val description = if (surface == null || quality == 0) "Lightweight 2D · measured fallback" else "Lightweight 2D"
            if (qualityStatus.text != description) qualityStatus.text = description
        }
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!resumed || disposed) return
        val now = SystemClock.elapsedRealtime()
        val dt = if (previous == 0L) 0f else ((frameTimeNanos - previous) / 1e9f).coerceIn(0f, .1f)
        previous = frameTimeNanos
        val current = source
        if (current != null) state.update(!ending && current.active, current.connected, current.microphoneLevel(now),
            current.playbackLevel(), now, dt, still())
        if (current != null && lastMode != state.mode) {
            lastMode = state.mode
            title.text = when (state.mode) { 0 -> "Connecting audio…"; 1 -> "Listening…"; 2 -> "Speaking…"; else -> "Call ended" }
        }
        applyPose()
        if (current != null) scheduler.postFrameCallbackDelayed(this, if (still()) 80L else 0L)
    }

    fun resume() {
        if (disposed || resumed) return
        resumed = true; previous = 0L
        refreshAppearance()
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
