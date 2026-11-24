package ru.eleven.ompaway

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
import com.example.radiance.LensPlacement
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
    private val placement = LensPlacement(topAnchored = true, density = resources.displayMetrics.density)
    private val state = CallVisualState()
    private val scheduler = Choreographer.getInstance()
    private val preferences = ScreenPreferences(context)
    private val fallback = OrbFallback(context, shell, this, placement)
    private var autoFlat = false
    private var quality = preferences.quality
    private var light = preferences.lightBackdrop
    private var animations = preferences.animations
    private val surface = try {
        OrbSurface(context, null, { useFallback() }, shell, this, placement)
    } catch (_: RuntimeException) { null } catch (_: LinkageError) { null }
    private val flat get() = surface == null || quality == 2 || (quality == 0 && autoFlat)
    private val title = label("Your desktop, in reach.", 30f)
    private val callNotice = label("Voice captions · Not a submitted answer", 12f)
    private val caller = label("", 16f)
    private val assistant = label("", 16f)
    private val transcript = CallTranscriptViews(title, caller, assistant)
    private val speaker = Button(context)
    private val end = Button(context)
    private val settingsButton = Button(context)
    private val controls = LinearLayout(context)
    private val content = LinearLayout(context)
    private val callActions = LinearLayout(context)
    private var speakerEnabled = false
    private var resumed = false
    private var disposed = false
    private var ending = false
    private var previous = 0L
    private var lastMode = -1
    private var finishDismissal: Runnable? = null
    private var panelOpen = false
    private var awaitingReply = false
    private var lastUserCaption = ""
    private var lastUserFinal = false
    private val heading = LinearLayout(context)
    private var safeLeft = 0
    private var safeRight = 0
    private var safeBottom = 0
    internal val voiceContentTop get() = (placement.restingBottom - placement.topInset).toInt() + dp(12)

    init {
        shell.target(4, true)
        setBackgroundColor(Color.BLACK)
        surface?.let { addView(it, LayoutParams(-1, -1)) }
        addView(fallback, LayoutParams(-1, -1))
        fallback.visibility = if (flat) VISIBLE else INVISIBLE
        heading.apply {
            gravity = Gravity.CENTER_VERTICAL
            background = RadianceUi.surface(context, 0xd9181824.toInt(), 24)
            setPadding(dp(16), dp(4), dp(8), dp(4))
        }
        heading.addView(label("away", 26f), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(settingsButton.apply {
            styleButton(this); text = "Settings"
            setOnClickListener { if (resumed) openSettings() }
        })
        addView(heading, LayoutParams(-1, -2, Gravity.TOP).apply { setMargins(dp(12), dp(8), dp(12), 0) })
        content.orientation = LinearLayout.VERTICAL
        content.setPadding(dp(16), dp(10), dp(16), dp(8))
        content.gravity = Gravity.CENTER_HORIZONTAL
        content.background = RadianceUi.surface(context, 0xc9181824.toInt(), 24)
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
        callActions.background = GradientDrawable().apply {
            setColor(0xcc1c1c2b.toInt()); cornerRadius = dp(26).toFloat()
        }
        callActions.setPadding(dp(6), dp(4), dp(6), dp(4))
        styleButton(speaker)
        speaker.setOnClickListener { if (resumed && !ending) changeSpeaker(!speakerEnabled) }
        styleButton(end)
        end.text = "Hang up"; end.setTextColor(0xffe9898f.toInt())
        end.setOnClickListener { if (resumed && !ending) hangup() }
        callActions.addView(speaker, LinearLayout.LayoutParams(0, -2, 1f))
        callActions.addView(Button(context).apply {
            styleButton(this); text = "Questions"
            contentDescription = "View questions and proposed answer"
            setOnClickListener { if (resumed && !ending) openInbox() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        callActions.addView(end, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(callActions, LinearLayout.LayoutParams(-1, -2))
        addView(controls, LayoutParams(-1, -2, Gravity.BOTTOM))
        setOnApplyWindowInsetsListener { _, insets ->
            val top: Int
            if (Build.VERSION.SDK_INT >= 30) {
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                safeLeft = safe.left; safeRight = safe.right; safeBottom = safe.bottom; top = safe.top
            } else {
                @Suppress("DEPRECATION")
                safeLeft = insets.systemWindowInsetLeft
                @Suppress("DEPRECATION")
                safeRight = insets.systemWindowInsetRight
                @Suppress("DEPRECATION")
                safeBottom = insets.systemWindowInsetBottom
                @Suppress("DEPRECATION")
                top = insets.systemWindowInsetTop
            }
            placement.resize(width, height, top.toFloat())
            layoutControls()
            surface?.refreshPlacement(); fallback.invalidate()
            insets
        }
        showActions()
        refreshAppearance()
        setSpeaker(false)
    }

    private fun styleButton(button: Button) = RadianceUi.styleButton(button, quiet = true)

    private fun showActions() {
        callActions.visibility = if (source == null) GONE else VISIBLE
        callNotice.visibility = if (source == null) GONE else VISIBLE
        heading.visibility = if (panelOpen || source == null) GONE else VISIBLE
        controls.visibility = if (panelOpen || source == null) INVISIBLE else VISIBLE
        settingsButton.visibility = if (panelOpen) GONE else VISIBLE
        content.gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
    }

    fun setPanelOpen(open: Boolean) {
        panelOpen = open
        showActions()
        importantForAccessibility = if (open) IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            else IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }

    fun bind(next: CallVisualSource?) {
        if (source === next) return
        finishDismissal?.let { removeCallbacks(it) }; finishDismissal = null
        source = next; ending = false; previous = 0L; lastMode = -1
        end.isEnabled = true; speaker.isEnabled = true
        state.update(false, false, 0f, 0f, 0L, 0f, true)
        state.update(next?.active == true, next?.connected == true, 0f, 0f, 0L, 0f, true)
        if (next == null && !resumed) shell.target(4, true)
        caller.text = ""; assistant.text = ""
        awaitingReply = false; lastUserCaption = ""; lastUserFinal = false
        caller.visibility = GONE; assistant.visibility = GONE
        showActions()
        applyPose()
        if (resumed) {
            scheduler.removeFrameCallback(this)
            scheduler.postFrameCallback(this)
        }
    }

    fun refreshAppearance() {
        val nextQuality = preferences.quality
        if (nextQuality != quality) autoFlat = false
        quality = nextQuality; light = preferences.lightBackdrop
        animations = preferences.animations
        applyPose()
    }

    private fun label(value: String, size: Float) = TextView(context).apply {
        text = value; textSize = size; setTextColor(0xfff4eee4.toInt())
        setPadding(0, dp(5), 0, dp(8))
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun still() = !animations

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        placement.resize(w, h)
        layoutControls()
        surface?.refreshPlacement(); fallback.invalidate()
    }

    private fun layoutControls() {
        heading.layoutParams = (heading.layoutParams as LayoutParams).apply {
            leftMargin = maxOf(dp(12), safeLeft)
            rightMargin = maxOf(dp(12), safeRight)
            topMargin = placement.topInset.toInt() + voiceContentTop
        }
        controls.setPadding(maxOf(dp(24), safeLeft), 0, maxOf(dp(24), safeRight), maxOf(dp(16), safeBottom))
        val viewportHeight = height
        val fraction = if (width > viewportHeight) .55f else .43f
        controls.layoutParams = (controls.layoutParams as LayoutParams).apply {
            height = (viewportHeight * fraction).toInt().coerceAtLeast(dp(190)).coerceAtMost(viewportHeight)
        }
    }

    fun setSpeaker(enabled: Boolean) {
        speakerEnabled = enabled
        speaker.text = if (enabled) "Speaker: on" else "Speaker: off"
    }

    fun captions(user: String, userFinal: Boolean, reply: String, replyFinal: Boolean) {
        val current = source ?: return
        if (userFinal && user.isNotBlank() && (user != lastUserCaption || !lastUserFinal)) {
            lastUserCaption = user; awaitingReply = true
        }
        lastUserFinal = userFinal
        assistant.gravity = Gravity.START
        transcript.update(current.connected, state.mode == 2, user, userFinal, reply, replyFinal, state.mode == 3)
    }

    override fun energy(seconds: Float, mode: Int) = if (source?.active != true || ending || still()) 0f else state.level

    private fun useFallback() {
        if (disposed || autoFlat) return
        autoFlat = true
        applyPose()
    }

    private fun applyPose() {
        val reduced = still()
        val mode = if (source?.active != true || ending) 4 else if (source?.connected != true) 0 else state.mode
        shell.target(mode, reduced)
        fallback.visibility = if (flat) VISIBLE else INVISIBLE
        surface?.update(mode, reduced, light, !flat, quality == 0)
        fallback.update(!reduced && flat, light, mode)
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!resumed || disposed) return
        val now = SystemClock.elapsedRealtime()
        val dt = if (previous == 0L) 0f else ((frameTimeNanos - previous) / 1e9f).coerceIn(0f, .1f)
        previous = frameTimeNanos
        val current = source
        if (current != null) {
            val playback = current.playbackLevel()
            if (playback > 0f) awaitingReply = false
            state.update(!ending && current.active, current.connected, current.microphoneLevel(now),
                playback, now, dt, still(), awaitingReply)
        }
        if (current != null && lastMode != state.mode) {
            lastMode = state.mode
            title.text = when (state.mode) { 0 -> "Connecting audio…"; 1 -> "Listening…"; 2 -> "Speaking…"; 3 -> "Thinking…"; else -> "Call ended" }
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
        if (source?.active != true || ending) shell.target(4, true)
        scheduler.removeFrameCallback(this)
        surface?.pause(); fallback.pause()
    }

    fun dismiss(finished: () -> Unit) {
        if (ending || disposed) return
        ending = true; end.isEnabled = false; speaker.isEnabled = false
        applyPose()
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
