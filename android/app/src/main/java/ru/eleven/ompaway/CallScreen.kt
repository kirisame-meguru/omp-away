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
import com.example.radiance.OrbLayer
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
    private val backgroundShell = ShellMotion().apply { target(4, true) }
    private val state = CallVisualState()
    private val scheduler = Choreographer.getInstance()
    private val preferences = ScreenPreferences(context)
    private val backgroundFallback = OrbFallback(context, backgroundShell, this, layer = OrbLayer.SCENE)
    private val fallback = OrbFallback(context, shell, this, placement, OrbLayer.LENS)
    private var autoFlat = false
    private var quality = preferences.quality
    private var light = preferences.lightBackdrop
    private var animations = preferences.animations
    private val backgroundSurface = try {
        OrbSurface(context, null, {}, backgroundShell, this, layer = OrbLayer.SCENE)
    } catch (_: RuntimeException) { null } catch (_: LinkageError) { null }
    private val surface = try {
        OrbSurface(context, null, { useFallback() }, shell, this, placement, OrbLayer.LENS)
    } catch (_: RuntimeException) { null } catch (_: LinkageError) { null }
    private val flat get() = surface == null || backgroundSurface == null || quality == 2 || (quality == 0 && autoFlat)
    internal val voiceOverlay = FrameLayout(context).apply {
        tag = "away.voice.foreground"
        isClickable = false; isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        surface?.let { addView(it, LayoutParams(-1, -1)) }
        addView(fallback, LayoutParams(-1, -1))
    }
    private val title = label("Voice call", 24f)
    private val callNotice = label("Voice captions · Not a submitted answer", 14f)
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
    private var safeTop = 0
    private val slotLocation = IntArray(2)
    private val overlayLocation = IntArray(2)

    init {
        shell.target(4, true)
        setBackgroundColor(Color.BLACK)
        backgroundSurface?.let { addView(it, LayoutParams(-1, -1)) }
        addView(backgroundFallback, LayoutParams(-1, -1))
        backgroundFallback.visibility = if (flat) VISIBLE else INVISIBLE
        heading.apply {
            gravity = Gravity.CENTER_VERTICAL
            background = RadianceUi.surface(context)
            setPadding(dp(16), dp(4), dp(8), dp(4))
        }
        heading.addView(label("away", 20f), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(end)
        addView(heading, LayoutParams(-1, -2, Gravity.TOP).apply { setMargins(dp(12), dp(8), dp(12), 0) })
        content.orientation = LinearLayout.VERTICAL
        content.setPadding(dp(16), dp(12), dp(16), dp(8))
        content.gravity = Gravity.CENTER_HORIZONTAL
        content.background = RadianceUi.surface(context)
        title.gravity = Gravity.CENTER
        title.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        content.addView(title, LinearLayout.LayoutParams(-1, -2))
        callNotice.gravity = Gravity.CENTER
        callNotice.setTextColor(RadianceUi.muted)
        content.addView(callNotice, LinearLayout.LayoutParams(-1, -2))
        caller.setTextColor(RadianceUi.muted)
        content.addView(caller, LinearLayout.LayoutParams(-1, -2))
        assistant.setTextColor(RadianceUi.muted)
        content.addView(assistant, LinearLayout.LayoutParams(-1, -2))
        controls.orientation = LinearLayout.VERTICAL
        controls.setPadding(dp(24), 0, dp(24), dp(16))
        val body = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(content, LinearLayout.LayoutParams(-1, -2))
        }
        val captions = ScrollView(context).apply { isFillViewport = true; addView(body) }
        controls.addView(captions, LinearLayout.LayoutParams(-1, -1))
        callActions.gravity = Gravity.CENTER
        callActions.background = GradientDrawable().apply {
            setColor(RadianceUi.cardColor); cornerRadius = dp(12).toFloat()
        }
        callActions.setPadding(dp(8), dp(4), dp(8), dp(4))
        styleButton(speaker)
        speaker.setOnClickListener { if (resumed && !ending) changeSpeaker(!speakerEnabled) }
        RadianceUi.styleButton(end, quiet = true, destructive = true)
        end.text = "Hang up"
        end.setOnClickListener { if (resumed && !ending) hangup() }
        callActions.addView(speaker, LinearLayout.LayoutParams(0, -2, 1f))
        callActions.addView(Button(context).apply {
            styleButton(this); text = "Questions"
            contentDescription = "View questions and proposed answer"
            setOnClickListener { if (resumed && !ending) openInbox() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        callActions.addView(settingsButton.apply {
            styleButton(this); text = "Settings"
            setOnClickListener { if (resumed) openSettings() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(callActions, LinearLayout.LayoutParams(-1, -2))
        addView(controls, LayoutParams(-1, -2, Gravity.BOTTOM))
        addView(voiceOverlay, LayoutParams(-1, -1))
        voiceOverlay.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            updatePlacement()
            layoutControls()
        }
        heading.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            updatePlacement()
            layoutControls()
        }
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
            safeTop = top
            updatePlacement()
            layoutControls()
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
        if (panelOpen && source == null) setVoiceOverlayVisible(false)
        content.gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
    }

    private fun setVoiceOverlayVisible(visible: Boolean) {
        val next = if (visible) VISIBLE else INVISIBLE
        if (voiceOverlay.visibility == next) return
        voiceOverlay.visibility = next
        // Stop hidden foreground rendering as well as hiding its View.
        applyPose()
    }

    fun setPanelOpen(open: Boolean) {
        if (panelOpen != open) {
            panelOpen = open
            if (!open) voiceOverlay.layoutParams = LayoutParams(-1, -1)
            updatePlacement()
            layoutControls()
            setVoiceOverlayVisible(!open)
        }
        showActions()
        importantForAccessibility = if (open) IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            else IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }

    fun placePanelLens(slot: View) {
        if (!panelOpen || source == null || slot.width <= 0 || slot.height <= 0) return
        slot.getLocationInWindow(slotLocation)
        (voiceOverlay.parent as? View)?.getLocationInWindow(overlayLocation) ?: return
        val size = minOf(slot.width, slot.height, dp(64))
        val left = slotLocation[0] - overlayLocation[0] + (slot.width - size) / 2
        val top = slotLocation[1] - overlayLocation[1] + (slot.height - size) / 2
        val params = voiceOverlay.layoutParams as LayoutParams
        if (params.width != size || params.height != size || params.leftMargin != left || params.topMargin != top) {
            params.width = size; params.height = size
            params.leftMargin = left; params.topMargin = top
            voiceOverlay.layoutParams = params
        }
        setVoiceOverlayVisible(true)
    }

    private fun updatePlacement() {
        placement.compact = panelOpen
        placement.resize(voiceOverlay.width, voiceOverlay.height,
            if (panelOpen) 0f else (safeTop + heading.height).toFloat())
        surface?.refreshPlacement()
        fallback.invalidate()
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
        text = value; textSize = size; setTextColor(RadianceUi.cream)
        setPadding(0, dp(4), 0, dp(8))
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun still() = !animations

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        updatePlacement()
        layoutControls()
    }

    private fun layoutControls() {
        heading.layoutParams = (heading.layoutParams as LayoutParams).apply {
            leftMargin = maxOf(dp(12), safeLeft)
            rightMargin = maxOf(dp(12), safeRight)
            topMargin = safeTop + dp(8)
        }
        controls.setPadding(maxOf(dp(24), safeLeft), 0, maxOf(dp(24), safeRight), maxOf(dp(16), safeBottom))
        val stacked = width / resources.displayMetrics.density / resources.configuration.fontScale < 360f
        val orientation = if (stacked) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        if (callActions.orientation != orientation) {
            callActions.orientation = orientation
            for (index in 0 until callActions.childCount) {
                callActions.getChildAt(index).layoutParams = if (stacked)
                    LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f)
            }
        }
        if (!panelOpen) {
            val top = (placement.restingBottom.toInt() + dp(16)).coerceIn(0, height)
            controls.layoutParams = (controls.layoutParams as LayoutParams).apply {
                height = this@CallScreen.height - top
            }
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
        val lensVisible = voiceOverlay.visibility == VISIBLE
        fallback.visibility = if (flat && lensVisible) VISIBLE else INVISIBLE
        backgroundFallback.visibility = if (flat) VISIBLE else INVISIBLE
        backgroundSurface?.update(4, true, light, !flat, false)
        backgroundFallback.update(false, light, 4)
        surface?.update(mode, reduced, light, !flat && lensVisible, quality == 0)
        fallback.update(!reduced && flat && lensVisible, light, mode)
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
        backgroundSurface?.resume(); backgroundFallback.resume()
        surface?.resume(); fallback.resume()
    }

    fun pause() {
        resumed = false; previous = 0L
        if (source?.active != true || ending) shell.target(4, true)
        scheduler.removeFrameCallback(this)
        backgroundSurface?.pause(); backgroundFallback.pause()
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
        backgroundSurface?.dispose()
    }
}
