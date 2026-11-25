package ru.eleven.ompaway

import android.Manifest
import androidx.appcompat.app.AppCompatActivity
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

class InboxActivity : AppCompatActivity() {
    private val app get() = application as Gateway
    private val titleIconFont by lazy(LazyThreadSafetyMode.NONE) { resources.getFont(R.font.title_symbols) }
    private lateinit var scroll: ScrollView
    private lateinit var refresh: InboxRefreshLayout
    private lateinit var column: LinearLayout
    private var selectedId: String? = null
    private var notice: String? = null
    private var resumed = false
    private val detailViews = mutableMapOf<String, QuestionDetailView>()
    private val formViews = mutableMapOf<String, QuestionFormView>()
    private var answerRequested: String? = null
    private var permissionAnswer: String? = null
    private var scanRequested = false
    private lateinit var callScreen: CallScreen
    private var callSource: CallVisualSource? = null
    private var restoreCallPage = false
    private lateinit var panel: LinearLayout
    private lateinit var panelHangup: Button
    private lateinit var screenPreferences: ScreenPreferences
    private lateinit var panelBack: ImageButton
    private lateinit var panelTitle: TextView
    private lateinit var panelSettings: ImageButton
    private lateinit var contentTarget: LinearLayout
    private lateinit var panelToolbar: LinearLayout
    private lateinit var pairingView: PairingView
    private lateinit var receiptToast: ReceiptToast
    private var page = Page.REQUESTS
    private var settingsReturn = Page.REQUESTS
    private var renderedPage: Page? = null
    private var renderedId: String? = null

    private enum class Page { REQUESTS, DETAILS, SETTINGS }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        restoreCallPage = savedInstanceState != null && app.callId != null
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
        scanRequested = savedInstanceState?.getBoolean("scanRequested") == true
        scroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
            // Hand edge pulls to the whole-card refresh parent instead of
            // stretching content inside a stationary native scroll viewport.
            isNestedScrollingEnabled = true
            overScrollMode = View.OVER_SCROLL_NEVER
        }
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
                    info.addAction(AccessibilityNodeInfo.AccessibilityAction(R.id.refresh_questions, uiString(R.string.refresh_questions)))
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
            contentDescription = uiString(R.string.back)
            tooltipText = uiString(R.string.back)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = RippleDrawable(ColorStateList.valueOf(0x33f4f1eb), null,
                RadianceUi.surface(this@InboxActivity))
            setOnClickListener { if (resumed) navigateBack() }
        }
        panelToolbar.addView(panelBack, LinearLayout.LayoutParams(dp(48), dp(48)))
        panelTitle = RadianceUi.text(this, uiString(R.string.questions), 24, heading = true).apply {
            setPadding(dp(8), dp(4), dp(8), dp(4))
        }
        panelToolbar.addView(panelTitle, LinearLayout.LayoutParams(0, -2, 1f))
        panelHangup = RadianceUi.button(this, uiString(R.string.hang_up), destructive = true) { if (resumed) app.hangup() }
        panelToolbar.addView(panelHangup, LinearLayout.LayoutParams(-2, -2))
        panelHeader.addView(panelToolbar, LinearLayout.LayoutParams(-1, -2))
        panelSettings = ImageButton(this).apply {
            setImageResource(R.drawable.ic_settings)
            imageTintList = ColorStateList.valueOf(RadianceUi.cream)
            contentDescription = uiString(R.string.settings)
            tooltipText = uiString(R.string.settings)
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
        val underlay = RefractiveContent(this).apply {
            addView(callScreen, FrameLayout.LayoutParams(-1, -1))
            addView(refresh, FrameLayout.LayoutParams(-1, -1))
            val voiceControls = callScreen.controlsOverlay
            (voiceControls.parent as? ViewGroup)?.removeView(voiceControls)
            addView(voiceControls)
            addView(receiptToast, FrameLayout.LayoutParams(-1, -1))
        }
        setContentView(FrameLayout(this).apply {
            addView(underlay, FrameLayout.LayoutParams(-1, -1))
            (callScreen.voiceOverlay.parent as? ViewGroup)?.removeView(callScreen.voiceOverlay)
            addView(callScreen.voiceOverlay, FrameLayout.LayoutParams(-1, -1))
        })
        callScreen.refract(underlay)
        overlay.viewTreeObserver.addOnGlobalLayoutListener {
            val voiceControls = callScreen.controlsOverlay
            val bottom = if (voiceControls.visibility == View.VISIBLE) voiceControls.height else 0
            if (scroll.paddingBottom != bottom)
                scroll.setPadding(scroll.paddingLeft, scroll.paddingTop, scroll.paddingRight, bottom)
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
            else if (page != Page.REQUESTS) navigateBack()
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
        if (!app.idle) { notice = uiString(R.string.hang_up_the_current_call_before_answering_another_request); render(); return }
        app.acknowledge(id)
        if (granted(Manifest.permission.RECORD_AUDIO)) app.join(id)
        else {
            permissionAnswer = id
            notice = uiString(R.string.microphone_permission_is_optional_you_can_still_answer_by_touch)
            if (askedAndDenied(Manifest.permission.RECORD_AUDIO)) { permissionAnswer = null; appSettings() }
            else ask(Manifest.permission.RECORD_AUDIO, MIC)
        }
    }

    override fun onResume() {
        super.onResume(); resumed = true
        applyScreenPrivacy()
        app.languageChanged()
        if (page == Page.SETTINGS) renderedPage = null
        if (app.callId == null) { callScreen.bind(null); callSource = null }
        callScreen.resume()
        app.foreground(::render, ::renderVoice, ::saveDrafts)
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
        app.background(recreating = true)
        super.onPause()
    }

    override fun onStop() {
        if (!isChangingConfigurations) app.background()
        super.onStop()
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
        outState.putBoolean("scanRequested", scanRequested)
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


    private fun showInboxPanel() {
        panel.visibility = View.VISIBLE
        panelHangup.visibility = if (app.callId != null) View.VISIBLE else View.GONE
        callScreen.setPanelOpen(true)
    }

    private fun navigateBack() {
        page = when (page) {
            Page.DETAILS -> Page.REQUESTS
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
        if (page != Page.REQUESTS) navigateBack() else super.onBackPressed()
    }

    private fun applyScreenPrivacy() { screenPreferences.apply(window) }

    private fun showSettings() {
        if (page != Page.SETTINGS) settingsReturn = page
        page = Page.SETTINGS
        render()
    }

    private fun renderSettings() {
        card {
            text(uiString(R.string.language_title), 20, bold = true)
            val languages = arrayOf("", "en", "ru")
            val labels = intArrayOf(R.string.language_system, R.string.language_english, R.string.language_russian)
            val choices = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
            val selected = AppLanguage.selected(this)
            for (index in languages.indices) {
                choices.addView(RadioButton(this).apply {
                    id = View.generateViewId()
                    text = uiString(labels[index])
                    setTextColor(RadianceUi.textColors)
                    buttonTintList = RadianceUi.tint
                    minHeight = dp(48); textSize = 16f
                    isChecked = languages[index] == selected
                    setOnClickListener {
                        if (resumed && AppLanguage.selected(this@InboxActivity) != languages[index]) {
                            saveDrafts()
                            AppLanguage.select(languages[index])
                        }
                    }
                }, RadioGroup.LayoutParams(-1, -2))
            }
            contentTarget.addView(choices)
            text(uiString(R.string.language_explanation), 14)
        }
        card {
            text(uiString(R.string.appearance), 20, bold = true)
            toggle(uiString(R.string.animations), screenPreferences.animations) {
                screenPreferences.animations = it; callScreen.refreshAppearance()
            }
            text(uiString(R.string.animate_the_scene_independently_of_system_motion_settings), 14)
            toggle(uiString(R.string.reference_backdrop), screenPreferences.lightBackdrop) {
                screenPreferences.lightBackdrop = it; callScreen.refreshAppearance()
            }
            text(uiString(R.string.rendering), 16, bold = true)
            val quality = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
            val ids = IntArray(3)
            for ((index, label) in arrayOf(uiString(R.string.auto), "GPU", "2D").withIndex()) {
                val choice = RadioButton(this).apply {
                    id = View.generateViewId(); text = label; setTextColor(RadianceUi.textColors)
                    buttonTintList = RadianceUi.tint
                    minHeight = dp(48); textSize = 16f
                    contentDescription = uiString(R.string.rendering_mode, label)
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
            text(uiString(R.string.privacy), 20, bold = true)
            toggle(uiString(R.string.block_screenshots), screenPreferences.blockScreenshots) {
                screenPreferences.blockScreenshots = it; applyScreenPrivacy()
            }
            text(uiString(R.string.hide_app_content_including_captions_and_pairing_details_in_screenshots), 14)
            toggle(uiString(R.string.notification_previews), app.inviteSettings.showPreview) {
                app.inviteSettings.showPreview = it; app.invitationSettingsChanged()
            }
            text(uiString(R.string.show_question_previews_lock_screen_privacy_still_applies_public_notifications), 14)
        }
        card {
            text(uiString(R.string.invitations), 20, bold = true)
            toggle(uiString(R.string.ringing_invitations), app.inviteSettings.callMode) {
                app.inviteSettings.callMode = it; app.invitationSettingsChanged()
            }
            text(uiString(R.string.turn_off_for_notifications_only_system_sound_vibration_and_do), 14)
            notificationSettings()
            if (Build.VERSION.SDK_INT >= 34) {
                if (!getSystemService(android.app.NotificationManager::class.java).canUseFullScreenIntent())
                    text(uiString(R.string.full_screen_calls_are_unavailable_incoming_calls_use_notifications_instead), 14)
                button(uiString(R.string.full_screen_call_settings)) {
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
                callScreen.bind(visual); callSource = visual
                if (!restoreCallPage) page = Page.REQUESTS
                restoreCallPage = false
            }
            callScreen.setSpeaker(app.speakerEnabled)
            renderVoice()
        } else {
            if (callSource != null) {
                callSource = null
                callScreen.dismiss { callScreen.bind(null); render() }
                return
            }
        }
        showInboxPanel()
        pairingView.setActive(page == Page.REQUESTS)
        app.takeAnswerReceipt()?.let { receiptToast.show(it, screenPreferences.animations) }
        refresh.isEnabled = page == Page.REQUESTS && app.canRefresh
        refresh.update(resumed && page == Page.REQUESTS && app.paired && !app.needsRelayOrigin && app.idle,
            app.inboxConnection, app.status, screenPreferences.animations)
        panelSettings.visibility = if (page == Page.REQUESTS) View.VISIBLE else View.GONE
        panelBack.visibility = if (page == Page.REQUESTS) View.GONE else View.VISIBLE
        panelToolbar.visibility = View.VISIBLE
        panelTitle.text = when (page) {
            Page.REQUESTS -> uiString(R.string.questions)
            Page.DETAILS -> uiString(R.string.question_details)
            Page.SETTINGS -> uiString(R.string.settings)
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
        column.removeAllViews(); contentTarget = column
        detailViews.keys.retainAll(app.store.state.pending.keys)
        formViews.keys.retainAll(app.store.state.pending.keys)
        when (page) {
            Page.SETTINGS -> renderSettings()
            Page.DETAILS -> renderDetails()
            Page.REQUESTS -> renderRequests()
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
        if (notice != null || app.pushWarning != null || !Invites.allowed(this)) card {
            notice?.let { text(it, 14) }
            app.pushWarning?.let { text(it, 14) }
            if (!Invites.allowed(this)) notificationSettings()
        }
        val state = app.store.state
        if (state.pending.isEmpty() && app.paired && !app.needsRelayOrigin) {
            text(uiString(R.string.no_pending_questions), 16).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(32), dp(16), dp(32))
            }
        }
        val rows = state.pending.values.sortedWith(compareByDescending<Pending> { it.id == app.callId }.thenByDescending { it.createdAt })
        for (item in rows) card {
            requestHeading(item)
            renderQuestionBody(item, showDetails = false)
            voiceButton(item)
            button(uiString(R.string.view_details)) { selectedId = item.id; app.acknowledge(item.id); page = Page.DETAILS; render() }
            if (item.id !in state.silenced && app.callId != item.id) button(uiString(R.string.not_now)) { app.silence(item.id) }
        }
        val awaiting = state.invited.filterNot { it in state.pending || it in state.closed }
        if (awaiting.isNotEmpty()) {
            text(uiString(R.string.missed_invitations), 22, bold = true)
            for (id in awaiting) card {
                text(if (id in state.silenced) uiString(R.string.desktop_request_silenced) else uiString(R.string.desktop_request_awaiting_sync), 16)
                if (id !in state.silenced) button(uiString(R.string.not_now)) { app.silence(id) }
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
            text(app.formMessage(item.id) ?: if (app.verifiedInbox) uiString(R.string.loading_question) else uiString(R.string.reconnect_to_answer), 16)
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
                text(uiString(R.string.this_question_cannot_be_displayed_here_review_details_or_answer), 16)
                return false
            }
        }
        (view.parent as? ViewGroup)?.removeView(view)
        view.availability(app.verifiedInbox, item.id in app.submitting, app.formMessage(item.id), canSubmit = app.idle)
        contentTarget.addView(view, LinearLayout.LayoutParams(-1, -2))
        return true
    }

    private fun voiceButton(item: Pending) {
        if (app.forms[item.id]?.optBoolean("voice", true) == false) return
        val control = RadianceUi.button(this, uiString(R.string.answer_by_voice)) { if (resumed) answer(item.id) }
        control.isEnabled = app.verifiedInbox && app.idle && item.id !in app.submitting
        getDrawable(android.R.drawable.ic_btn_speak_now)?.mutate()?.let { microphone ->
            microphone.setBounds(0, 0, dp(20), dp(20))
            microphone.setTint(if (control.isEnabled) RadianceUi.cream else RadianceUi.disabled)
            // Inline with the label so Gravity.CENTER centers the entire group.
            control.text = SpannableString("\uFFFC  " + uiString(R.string.answer_by_voice)).apply {
                setSpan(ImageSpan(microphone, ImageSpan.ALIGN_CENTER), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        control.contentDescription = uiString(R.string.answer_by_voice_description, if (app.verifiedInbox) item.question else uiString(R.string.pending_question))
        contentTarget.addView(control, RadianceUi.rowParams(this))
    }

    private fun requestHeading(item: Pending) {
        val title = if (app.verifiedInbox) item.session?.takeIf { it.isNotBlank() } ?: item.project
            else uiString(R.string.desktop_request_pending_sync)
        val label = title.trim().ifBlank { uiString(R.string.desktop_request) }
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
            if (item.id in app.store.state.silenced) uiString(R.string.silenced) else "", 14)
    }

    private fun renderDetails() {
        val state = app.store.state
        val item = state.pending[selectedId]
        if (item == null) {
            card { text(if (app.verifiedInbox) uiString(R.string.that_request_is_no_longer_pending) else uiString(R.string.request_awaiting_sync_reconnect_to_review_it), 18) }
            button(uiString(R.string.all_questions)) { page = Page.REQUESTS; render() }
            return
        }
        card {
            requestHeading(item)
            notice?.let { text(it, 14) }
            renderQuestionBody(item, showDetails = true)
        }
        if (app.callId == item.id) {
            card {
                text(uiString(R.string.proposed_answer_not_confirmed_or_submitted), 18, bold = true)
                text(if (app.verifiedInbox) state.proposals[item.id] ?: uiString(R.string.no_current_proposal_from_the_desktop)
                    else uiString(R.string.reconnect_to_review_the_current_proposed_answer), 16)
            }
        }
        voiceButton(item)
        if (item.id !in state.silenced && app.callId != item.id) button(uiString(R.string.not_now)) { app.silence(item.id) }
    }


    private fun notificationSettings() {
        if (!Invites.allowed(this)) text(uiString(R.string.notifications_are_off_pending_questions_still_appear_on_the_home), 14)
        button(if (Invites.allowed(this)) uiString(R.string.notification_settings) else uiString(R.string.enable_invitations)) {
            if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS) && !askedAndDenied(Manifest.permission.POST_NOTIFICATIONS))
                ask(Manifest.permission.POST_NOTIFICATIONS, NOTIFICATIONS)
            else if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) appSettings()
            else startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
    }

    private fun renderVoice() {
        if (!resumed || app.callId == null) return
        callScreen.captions(app.callerCaption, app.callerCaptionFinal, app.assistantCaption, app.assistantCaptionFinal)
    }

    private fun scan() {
        if (!resumed || page != Page.REQUESTS) return
        if (!granted(Manifest.permission.CAMERA)) {
            pairingView.message(uiString(R.string.camera_access_is_needed_to_scan_you_can_also_pair))
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
            pairingView.message(if (granted) null else uiString(R.string.camera_permission_denied_scan_again_to_retry_or_pair_from))
        } else {
            notice = if (granted) null else if (requestCode == MIC)
                uiString(R.string.microphone_unavailable_you_can_still_answer_by_touch) else uiString(R.string.questions_remain_on_the_home_screen)
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

