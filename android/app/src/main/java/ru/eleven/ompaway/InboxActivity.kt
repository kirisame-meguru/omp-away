package ru.eleven.ompaway

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.content.res.ColorStateList
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ImageSpan
import android.text.style.TypefaceSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.window.OnBackInvokedDispatcher
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Switch
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.ImageButton
import java.text.DateFormat
import java.util.Date

class InboxActivity : Activity() {
    private val app get() = application as Gateway
    private val titleIconFont by lazy(LazyThreadSafetyMode.NONE) { resources.getFont(R.font.title_symbols) }
    private lateinit var scroll: ScrollView
    private lateinit var refresh: InboxRefreshLayout
    private lateinit var column: LinearLayout
    private var selectedId: String? = null
    private var notice: String? = null
    private var resumed = false
    private var transcriptViews: CallTranscriptViews? = null
    private val detailViews = mutableMapOf<String, QuestionDetailView>()
    private val formViews = mutableMapOf<String, QuestionFormView>()
    private var answerRequested: String? = null
    private var permissionAnswer: String? = null
    private var scanRequested = false
    private lateinit var callScreen: CallScreen
    private var callSource: CallVisualSource? = null
    private lateinit var panel: LinearLayout
    private lateinit var panelHangup: Button
    private lateinit var screenPreferences: ScreenPreferences
    private lateinit var panelBack: ImageButton
    private lateinit var panelTitle: TextView
    private lateinit var panelSettings: ImageButton
    private lateinit var contentTarget: LinearLayout
    private lateinit var panelToolbar: LinearLayout
    private lateinit var panelLensSlot: View
    private lateinit var pairingView: PairingView
    private lateinit var receiptToast: ReceiptToast
    private var page = Page.REQUESTS
    private var settingsReturn = Page.REQUESTS
    private var renderedPage: Page? = null
    private var renderedId: String? = null

    private enum class Page { NONE, REQUESTS, DETAILS, SETTINGS }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        screenPreferences = ScreenPreferences(this)
        screenPreferences.apply(window)
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        @Suppress("DEPRECATION")
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        window.isStatusBarContrastEnforced = false
        window.isNavigationBarContrastEnforced = false
        page = Page.values().firstOrNull { it.name == savedInstanceState?.getString("page") } ?: Page.REQUESTS
        selectedId = savedInstanceState?.getString("selectedId")
        settingsReturn = Page.values().firstOrNull { it.name == savedInstanceState?.getString("settingsReturn") } ?: Page.REQUESTS
        answerRequested = savedInstanceState?.getString("answerRequested")?.takeIf(::validId)
        permissionAnswer = savedInstanceState?.getString("permissionAnswer")?.takeIf(::validId)
        scroll = ScrollView(this).apply { isFillViewport = true; clipToPadding = false }
        column = RadianceUi.column(this).apply { setPadding(dp(16), 0, dp(16), dp(20)) }
        contentTarget = column
        scroll.addView(column)
        refresh = InboxRefreshLayout(this).apply {
            canScrollUp = { scroll.canScrollVertically(-1) }
            onRefresh = {
                if (resumed && page == Page.REQUESTS && app.canRefresh && !app.refreshing) {
                    saveDrafts()
                    notice = null
                    app.refreshQuestions()
                    true
                } else false
            }
        }
        scroll.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                if (page == Page.REQUESTS && app.canRefresh && !app.refreshing)
                    info.addAction(AccessibilityNodeInfo.AccessibilityAction(R.id.refresh_questions, "Refresh questions"))
            }
            override fun performAccessibilityAction(host: View, action: Int, args: Bundle?): Boolean {
                if (action == R.id.refresh_questions && resumed && page == Page.REQUESTS && app.canRefresh && !app.refreshing) {
                    return refresh.requestRefresh()
                }
                return super.performAccessibilityAction(host, action, args)
            }
        }
        callScreen = CallScreen(this, null, app::setSpeakerEnabled, app::hangup, ::openInbox, ::showSettings)
        pairingView = PairingView(this, app, ::scan)
        receiptToast = ReceiptToast(this)
        val panelHeader = RadianceUi.column(this).apply {
            setPadding(dp(12), dp(8), dp(12), 0)
        }
        panelToolbar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        panelBack = ImageButton(this).apply {
            setImageResource(R.drawable.ic_arrow_back)
            imageTintList = ColorStateList.valueOf(RadianceUi.cream)
            contentDescription = "Back"
            tooltipText = "Back"
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = RippleDrawable(ColorStateList.valueOf(0x33f4f1eb), null,
                RadianceUi.surface(this@InboxActivity))
            setOnClickListener { if (resumed) navigateBack() }
        }
        panelToolbar.addView(panelBack, LinearLayout.LayoutParams(dp(48), dp(48)))
        panelLensSlot = View(this).apply {
            minimumWidth = dp(48)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        panelTitle = RadianceUi.text(this, "Questions", 24, heading = true).apply {
            setPadding(dp(8), dp(4), dp(8), dp(4))
        }
        panelToolbar.addView(panelTitle, LinearLayout.LayoutParams(0, -2, 1f))
        panelToolbar.addView(panelLensSlot, LinearLayout.LayoutParams(dp(56), dp(56)))
        panelHangup = RadianceUi.button(this, "Hang up", destructive = true) { if (resumed) app.hangup() }
        panelToolbar.addView(panelHangup, LinearLayout.LayoutParams(-2, -2))
        panelHeader.addView(panelToolbar, LinearLayout.LayoutParams(-1, -2))
        panelSettings = ImageButton(this).apply {
            setImageResource(R.drawable.ic_settings)
            imageTintList = ColorStateList.valueOf(RadianceUi.cream)
            contentDescription = "Settings"
            tooltipText = "Settings"
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = RippleDrawable(ColorStateList.valueOf(0x33f4f1eb), null,
                RadianceUi.surface(this@InboxActivity))
            setOnClickListener { if (resumed) showSettings() }
        }
        panelToolbar.addView(panelSettings, LinearLayout.LayoutParams(dp(48), dp(48)))
        panel = RadianceUi.column(this).apply {
            background = RadianceUi.surface(this@InboxActivity)
            visibility = View.GONE
            addView(panelHeader, LinearLayout.LayoutParams(-1, -2))
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        val overlay = FrameLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            addView(panel, FrameLayout.LayoutParams(-1, -1).apply {
                setMargins(dp(12), dp(12), dp(12), dp(12))
            })
        }
        refresh.setContent(overlay)
        setContentView(FrameLayout(this).apply {
            addView(callScreen, FrameLayout.LayoutParams(-1, -1))
            addView(refresh, FrameLayout.LayoutParams(-1, -1))
            (callScreen.voiceOverlay.parent as? ViewGroup)?.removeView(callScreen.voiceOverlay)
            addView(callScreen.voiceOverlay, FrameLayout.LayoutParams(-1, -1))
            addView(receiptToast, FrameLayout.LayoutParams(-1, -1))
        })
        overlay.viewTreeObserver.addOnGlobalLayoutListener {
            if (panelLensSlot.visibility == View.VISIBLE) callScreen.placePanelLens(panelLensSlot)
        }
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.setSystemBarsAppearance(0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
            overlay.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                refresh.setTopInset(safe.top)
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                receiptToast.setPadding(safe.left + dp(24), safe.top + dp(16), safe.right + dp(24), safe.bottom + dp(24))
                insets
            }
        } else {
            overlay.fitsSystemWindows = true
            overlay.setOnApplyWindowInsetsListener { view, insets ->
                @Suppress("DEPRECATION")
                refresh.setTopInset(insets.systemWindowInsetTop)
                receiptToast.setPadding(dp(24), insets.systemWindowInsetTop + dp(16), dp(24), insets.systemWindowInsetBottom + dp(24))
                view.onApplyWindowInsets(insets)
            }
        }
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT
        ) {
            if (pairingView.cancelScan()) Unit
            else if (page != Page.NONE && page != Page.REQUESTS) navigateBack()
            else if (isTaskRoot) moveTaskToBack(true) else finish()
        }
        // Recreation restores an already-authorized action, rather than replaying the launch intent.
        if (savedInstanceState == null) takeInvite(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent); takeInvite(intent)
        if (resumed) { render(); continueAnswer() }
    }
    private fun takeInvite(intent: Intent) {
        if (intent.action != Invites.OPEN && intent.action != Invites.ANSWER) return
        val id = intent.getStringExtra(Invites.ID)?.takeIf(::validId) ?: return
        selectedId = id
        page = Page.DETAILS
        app.acknowledge(id)
        // Only the private PendingIntent alias may request an automatic voice join.
        // An arbitrary launcher/deep-link intent merely opens the question, never submits or joins.
        if (intent.action == Invites.ANSWER && intent.component?.className == "$packageName.AnswerCall") answerRequested = id
    }

    private fun answer(id: String) {
        selectedId = id; answerRequested = id; continueAnswer()
    }

    private fun continueAnswer() {
        if (!resumed) return
        val id = answerRequested ?: return
        answerRequested = null
        if (!app.idle) { notice = "Hang up the current call before answering another request."; render(); return }
        app.acknowledge(id)
        if (granted(Manifest.permission.RECORD_AUDIO)) app.join(id)
        else {
            permissionAnswer = id
            notice = "Microphone permission is optional. You can still answer by touch."
            if (askedAndDenied(Manifest.permission.RECORD_AUDIO)) { permissionAnswer = null; appSettings() }
            else ask(Manifest.permission.RECORD_AUDIO, MIC)
        }
    }

    override fun onResume() {
        super.onResume(); resumed = true
        applyScreenPrivacy()
        if (page == Page.SETTINGS) renderedPage = null
        if (app.callId == null) { callScreen.bind(null); callSource = null }
        callScreen.resume()
        app.foreground(::render, ::renderVoice)
        pairingView.setActive(page == Page.REQUESTS)
        continueAnswer()
        if (scanRequested) {
            scanRequested = false
            if (page == Page.REQUESTS) scan()
        }
    }
    override fun onPause() {
        resumed = false
        refresh.pause()
        pairingView.setActive(false)
        receiptToast.dismiss()
        saveDrafts()
        callScreen.pause()
        app.background()
        super.onPause()
    }

    override fun onDestroy() {
        callScreen.dispose()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        saveDrafts()
        outState.putString("page", page.name)
        outState.putString("selectedId", selectedId)
        outState.putString("settingsReturn", settingsReturn.name)
        outState.putString("answerRequested", answerRequested)
        outState.putString("permissionAnswer", permissionAnswer)
        super.onSaveInstanceState(outState)
    }

    private fun saveDrafts() {
        for ((id, view) in formViews) if (id in app.store.state.pending && id in app.forms) {
            app.drafts[id] = view.values()
            app.noteDrafts[id] = view.notes()
        }
    }

    private fun openInbox() {
        page = Page.REQUESTS
        render()
    }


    private fun showInboxPanel(open: Boolean) {
        panel.visibility = if (open) View.VISIBLE else View.GONE
        panelHangup.visibility = if (app.callId != null) View.VISIBLE else View.GONE
        panelLensSlot.visibility = if (app.callId != null) View.VISIBLE else View.GONE
        callScreen.setPanelOpen(open)
    }

    private fun navigateBack() {
        page = when (page) {
            Page.DETAILS -> if (app.callId != null) Page.NONE else Page.REQUESTS
            Page.SETTINGS -> settingsReturn
            else -> Page.REQUESTS
        }
        renderedPage = null
        render()
    }

    // API 29–32 only; API 33+ uses OnBackInvokedDispatcher above.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Platform back callback")
    override fun onBackPressed() {
        if (pairingView.cancelScan()) return
        if (page != Page.NONE && page != Page.REQUESTS) navigateBack() else super.onBackPressed()
    }

    private fun applyScreenPrivacy() { screenPreferences.apply(window) }

    private fun showSettings() {
        settingsReturn = page
        page = Page.SETTINGS
        render()
    }

    private fun renderSettings() {
        card {
            text("Appearance", 20, bold = true)
            toggle("Animations", screenPreferences.animations) {
                screenPreferences.animations = it; callScreen.refreshAppearance()
            }
            text("Animate the scene independently of system motion settings.", 14)
            toggle("Reference backdrop", screenPreferences.lightBackdrop) {
                screenPreferences.lightBackdrop = it; callScreen.refreshAppearance()
            }
            text("Rendering", 16, bold = true)
            val quality = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
            val ids = IntArray(3)
            for ((index, label) in arrayOf("Auto", "GPU", "2D").withIndex()) {
                val choice = RadioButton(this).apply {
                    id = View.generateViewId(); text = label; setTextColor(RadianceUi.textColors)
                    buttonTintList = RadianceUi.tint
                    minHeight = dp(48); textSize = 16f
                    contentDescription = "$label rendering"
                }
                ids[index] = choice.id
                quality.addView(choice, RadioGroup.LayoutParams(-1, -2))
            }
            quality.check(ids[screenPreferences.quality])
            quality.setOnCheckedChangeListener { _, id ->
                val selected = ids.indexOf(id)
                if (selected >= 0) { screenPreferences.quality = selected; callScreen.refreshAppearance() }
            }
            contentTarget.addView(quality)
        }
        card {
            text("Privacy", 20, bold = true)
            toggle("Block screenshots", screenPreferences.blockScreenshots) {
                screenPreferences.blockScreenshots = it; applyScreenPrivacy()
            }
            text("Hide app content, including captions and pairing details, in screenshots and recordings.", 14)
            toggle("Notification previews", app.inviteSettings.showPreview) {
                app.inviteSettings.showPreview = it; app.invitationSettingsChanged()
            }
            text("Show question previews. Lock-screen privacy still applies; public notifications stay redacted.", 14)
        }
        card {
            text("Invitations", 20, bold = true)
            toggle("Ringing invitations", app.inviteSettings.callMode) {
                app.inviteSettings.callMode = it; app.invitationSettingsChanged()
            }
            text("Turn off for notifications only. System sound, vibration and Do Not Disturb settings apply.", 14)
            notificationSettings()
            if (Build.VERSION.SDK_INT >= 34) {
                if (!getSystemService(android.app.NotificationManager::class.java).canUseFullScreenIntent())
                    text("Full-screen calls are unavailable. Incoming calls use notifications instead.", 14)
                button("Full-screen call settings") {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
                }
            }
        }
    }

    private fun render() {
        if (!resumed || isFinishing) return
        val visual = app.callVisual
        if (visual != null) {
            if (callSource !== visual) {
                callScreen.bind(visual); callSource = visual; page = Page.NONE
            }
            callScreen.setSpeaker(app.speakerEnabled)
            renderVoice()
        } else {
            if (callSource != null) {
                callSource = null
                page = Page.REQUESTS
                callScreen.dismiss { callScreen.bind(null); render() }
                return
            }
            if (page == Page.NONE) page = Page.REQUESTS
        }
        showInboxPanel(page != Page.NONE)
        pairingView.setActive(page == Page.REQUESTS)
        app.takeAnswerReceipt()?.let { receiptToast.show(it, screenPreferences.animations) }
        refresh.isEnabled = page == Page.REQUESTS && app.canRefresh
        refresh.update(resumed && page == Page.REQUESTS && app.paired && !app.needsRelayOrigin && app.idle,
            app.inboxConnection, app.status, screenPreferences.animations)
        panelSettings.visibility = if (page == Page.REQUESTS) View.VISIBLE else View.GONE
        if (page == Page.NONE) { renderedPage = null; return }
        panelBack.visibility = if (page == Page.REQUESTS) View.GONE else View.VISIBLE
        panelToolbar.visibility = View.VISIBLE
        panelTitle.text = when (page) {
            Page.REQUESTS -> "Questions"
            Page.DETAILS -> "Question details"
            Page.SETTINGS -> "Settings"
            Page.NONE -> ""
        }
        // Keep controls, focused input and scroll position stable while gateway state changes.
        if (renderedPage == page && page == Page.SETTINGS) return
        if (renderedPage == Page.REQUESTS && page == Page.REQUESTS &&
            pairingView.parent != null && (!app.paired || app.needsRelayOrigin)) {
            pairingView.bind()
            return
        }
        val y = if (renderedPage == page && renderedId == selectedId) scroll.scrollY else 0
        renderedPage = page; renderedId = selectedId
        val focused = currentFocus
        saveDrafts()
        column.removeAllViews(); contentTarget = column; transcriptViews = null
        detailViews.keys.retainAll(app.store.state.pending.keys)
        formViews.keys.retainAll(app.store.state.pending.keys)
        when (page) {
            Page.SETTINGS -> renderSettings()
            Page.DETAILS -> renderDetails()
            Page.REQUESTS -> renderRequests()
            Page.NONE -> Unit
        }
        if (focused?.isAttachedToWindow == true) focused.requestFocus()
        scroll.post { scroll.scrollTo(0, y) }
    }

    private fun renderRequests() {
        if (!app.paired || app.needsRelayOrigin) {
            (pairingView.parent as? ViewGroup)?.removeView(pairingView)
            contentTarget.addView(pairingView, RadianceUi.rowParams(this))
            pairingView.bind()
            pairingView.setActive(true)
        }
        if (notice != null || app.pushWarning != null || !Invites.allowed(this) || app.callId != null) card {
            notice?.let { text(it, 14) }
            app.pushWarning?.let { text(it, 14) }
            if (!Invites.allowed(this)) notificationSettings()
            if (app.callId != null) button("Return to voice") { page = Page.NONE; render() }
        }
        val state = app.store.state
        if (state.pending.isEmpty() && app.paired && !app.needsRelayOrigin) {
            text("No pending questions.", 16).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(32), dp(16), dp(32))
            }
        }
        val rows = state.pending.values.sortedWith(compareByDescending<Pending> { it.id == app.callId }.thenByDescending { it.createdAt })
        for (item in rows) card {
            requestHeading(item)
            renderQuestionBody(item, showDetails = false)
            voiceButton(item)
            button("View details") { selectedId = item.id; app.acknowledge(item.id); page = Page.DETAILS; render() }
            if (item.id !in state.silenced && app.callId != item.id) button("Not now") { app.silence(item.id) }
        }
        val awaiting = state.invited.filterNot { it in state.pending || it in state.closed }
        if (awaiting.isNotEmpty()) {
            text("Missed invitations", 22, bold = true)
            for (id in awaiting) card {
                text(if (id in state.silenced) "Desktop request · Silenced" else "Desktop request · Awaiting sync", 16)
                if (id !in state.silenced) button("Not now") { app.silence(id) }
            }
        }
    }

    private fun renderQuestionBody(item: Pending, showDetails: Boolean) {
        if (renderForm(item)) return
        if (showDetails) {
            val detail = detailViews.getOrPut(item.id) { QuestionDetailView(this) }
            (detail.parent as? ViewGroup)?.removeView(detail)
            detail.bind(item, app.store.state.details[item.id], app.verifiedInbox)
            contentTarget.addView(detail, LinearLayout.LayoutParams(-1, -2))
        } else if (app.verifiedInbox) text(item.question, 16)
    }

    private fun renderForm(item: Pending): Boolean {
        val schema = app.forms[item.id]
        if (schema == null || !app.verifiedInbox) {
            text(app.formMessages[item.id] ?: if (app.verifiedInbox) "Loading question…" else "Reconnect to answer.", 16)
            app.loadForm(item.id)
            return false
        }
        val cached = formViews[item.id]
        val view = if (cached != null && cached.schema === schema) cached else {
            try {
                QuestionFormView(this, schema, cached?.values() ?: app.drafts[item.id],
                    cached?.notes() ?: app.noteDrafts[item.id]) { values, notes ->
                    if (resumed) app.answer(item.id, values, notes)
                }.also { formViews[item.id] = it }
            } catch (_: org.json.JSONException) {
                text("This question cannot be displayed here. Review details or answer on the desktop.", 16)
                return false
            }
        }
        (view.parent as? ViewGroup)?.removeView(view)
        view.availability(app.verifiedInbox && app.idle, item.id in app.submitting, app.formMessages[item.id])
        contentTarget.addView(view, LinearLayout.LayoutParams(-1, -2))
        return true
    }

    private fun voiceButton(item: Pending) {
        if (app.forms[item.id]?.optBoolean("voice", true) == false) return
        val control = RadianceUi.button(this, "Answer by voice") { if (resumed) answer(item.id) }
        control.isEnabled = app.verifiedInbox && app.idle && item.id !in app.submitting
        getDrawable(android.R.drawable.ic_btn_speak_now)?.mutate()?.let { microphone ->
            microphone.setBounds(0, 0, dp(20), dp(20))
            microphone.setTint(if (control.isEnabled) RadianceUi.cream else RadianceUi.disabled)
            // Inline with the label so Gravity.CENTER centers the entire group.
            control.text = SpannableString("\uFFFC  Answer by voice").apply {
                setSpan(ImageSpan(microphone, ImageSpan.ALIGN_CENTER), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        control.contentDescription = "Answer by voice: ${if (app.verifiedInbox) item.question else "Pending question"}"
        contentTarget.addView(control, RadianceUi.rowParams(this))
    }

    private fun requestHeading(item: Pending) {
        val title = if (app.verifiedInbox) item.session?.takeIf { it.isNotBlank() } ?: item.project
            else "Desktop request · Pending sync"
        val label = title.trim().ifBlank { "Desktop request" }
        var decorated: SpannableString? = null
        var offset = 0
        while (offset < label.length) {
            val point = label.codePointAt(offset)
            val end = offset + Character.charCount(point)
            if (Character.getType(point) == Character.PRIVATE_USE.toInt()) {
                val spans = decorated ?: SpannableString(label).also { decorated = it }
                spans.setSpan(TypefaceSpan(titleIconFont), offset, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            offset = end
        }
        // Only desktop icon glyphs use the bundled font; normal text and color emoji keep Android fallback.
        text(label, 14, bold = true).also { heading -> decorated?.let { heading.text = it } }
        text(DateFormat.getDateTimeInstance().format(Date(item.createdAt)) +
            if (item.id in app.store.state.silenced) " · Silenced" else "", 14)
    }

    private fun renderDetails() {
        val state = app.store.state
        val item = state.pending[selectedId]
        if (item == null) {
            card { text(if (app.verifiedInbox) "That request is no longer pending." else "Request awaiting sync. Reconnect to review it.", 18) }
            button("All questions") { page = Page.REQUESTS; render() }
            return
        }
        card {
            requestHeading(item)
            notice?.let { text(it, 14) }
            renderQuestionBody(item, showDetails = true)
        }
        if (app.callId == item.id) {
            card {
                text("Proposed answer · Not confirmed or submitted", 18, bold = true)
                text(if (app.verifiedInbox) state.proposals[item.id] ?: "No current proposal from the desktop."
                    else "Reconnect to review the current proposed answer.", 16)
            }
            card {
                text("Voice captions · Not a submitted answer", 18, bold = true)
                transcriptViews = CallTranscriptViews(text("", 20, bold = true), text("", 16), text("", 16))
                renderVoice()
                toggle("Speaker", app.speakerEnabled) { app.setSpeakerEnabled(it) }
            }
        }
        voiceButton(item)
        if (item.id !in state.silenced && app.callId != item.id) button("Not now") { app.silence(item.id) }
    }


    private fun notificationSettings() {
        if (!Invites.allowed(this)) text("Notifications are off. Pending questions still appear on the home screen.", 14)
        button(if (Invites.allowed(this)) "Notification settings" else "Enable invitations") {
            if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS) && !askedAndDenied(Manifest.permission.POST_NOTIFICATIONS))
                ask(Manifest.permission.POST_NOTIFICATIONS, NOTIFICATIONS)
            else if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) appSettings()
            else startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
    }

    private fun renderVoice() {
        if (!resumed || app.callId == null) return
        callScreen.captions(app.callerCaption, app.callerCaptionFinal, app.assistantCaption, app.assistantCaptionFinal)
        transcriptViews?.update(app.talking, app.speaking, app.callerCaption, app.callerCaptionFinal,
            app.assistantCaption, app.assistantCaptionFinal)
    }

    private fun scan() {
        if (!resumed || page != Page.REQUESTS) return
        if (!granted(Manifest.permission.CAMERA)) {
            pairingView.message("Camera access is needed to scan. You can also pair from the clipboard.")
            if (askedAndDenied(Manifest.permission.CAMERA)) appSettings()
            else ask(Manifest.permission.CAMERA, CAMERA)
            return
        }
        pairingView.startScan()
    }

    private fun granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    private fun askedAndDenied(permission: String) = getPreferences(MODE_PRIVATE).getBoolean(permission, false) && !shouldShowRequestPermissionRationale(permission)
    private fun ask(permission: String, code: Int) {
        getPreferences(MODE_PRIVATE).edit().putBoolean(permission, true).apply()
        requestPermissions(arrayOf(permission), code)
    }
    private fun appSettings() { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        if (requestCode == CAMERA) {
            pairingView.message(if (granted) null else "Camera permission denied. Scan again to retry, or pair from the clipboard.")
        } else {
            notice = if (granted) null else if (requestCode == MIC)
                "Microphone unavailable. You can still answer by touch." else "Questions remain on the home screen."
        }
        if (requestCode == MIC) {
            val id = permissionAnswer; permissionAnswer = null
            if (granted) answerRequested = id
            continueAnswer()
        }
        if (requestCode == CAMERA && granted) {
            if (resumed && page == Page.REQUESTS) scan() else scanRequested = true
        }
        if (resumed) render()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
    private fun text(value: String, sp: Int, bold: Boolean = false): TextView =
        RadianceUi.text(this, value, sp, bold).also { contentTarget.addView(it) }

    private fun button(label: String, primary: Boolean = false, action: () -> Unit) {
        contentTarget.addView(RadianceUi.button(this, label, primary = primary) { if (resumed) action() }, RadianceUi.rowParams(this))
    }

    private fun toggle(label: String, checked: Boolean, changed: (Boolean) -> Unit) {
        contentTarget.addView(Switch(this).apply {
            text = label; textSize = 16f; setTextColor(RadianceUi.textColors)
            minHeight = dp(56); setPadding(0, dp(8), 0, dp(8))
            thumbTintList = RadianceUi.tint
            trackTintList = RadianceUi.trackTint
            isChecked = checked
            setOnCheckedChangeListener { _, enabled -> if (resumed) changed(enabled) }
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun card(content: () -> Unit) {
        val parent = contentTarget
        val card = RadianceUi.column(this, card = true)
        parent.addView(card, RadianceUi.rowParams(this))
        contentTarget = card
        try { content() } finally { contentTarget = parent }
    }
    private companion object { const val MIC = 1; const val NOTIFICATIONS = 2; const val CAMERA = 3 }
}

