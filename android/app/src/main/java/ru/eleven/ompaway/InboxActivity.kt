package ru.eleven.ompaway

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Switch
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.EditText
import com.google.zxing.integration.android.IntentIntegrator
import com.journeyapps.barcodescanner.CaptureActivity
import java.text.DateFormat
import java.util.Date

class InboxActivity : Activity() {
    private val app get() = application as Gateway
    private lateinit var scroll: ScrollView
    private lateinit var column: LinearLayout
    private var selectedId: String? = null
    private var incomingPair: String? = null
    private var notice: String? = null
    private var shownEmoji: String? = null
    private var verificationReturn = Page.PAIRING
    private var resumed = false
    private var transcriptViews: CallTranscriptViews? = null
    private val detailViews = mutableMapOf<String, QuestionDetailView>()
    private val formViews = mutableMapOf<String, QuestionFormView>()
    private var answerRequested: String? = null
    private var permissionAnswer: String? = null
    private lateinit var callScreen: CallScreen
    private var callSource: CallVisualSource? = null
    private lateinit var panel: LinearLayout
    private lateinit var panelHangup: Button
    private lateinit var screenPreferences: ScreenPreferences
    private lateinit var panelBack: Button
    private lateinit var panelTitle: TextView
    private lateinit var contentTarget: LinearLayout
    private var page = Page.REQUESTS
    private var settingsReturn = Page.REQUESTS
    private var renderedPage: Page? = null
    private var renderedId: String? = null

    private enum class Page { NONE, REQUESTS, PAIRING, DETAILS, SETTINGS, RELAY, VERIFY }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        screenPreferences = ScreenPreferences(this)
        screenPreferences.apply(window)
        page = Page.values().firstOrNull { it.name == savedInstanceState?.getString("page") } ?: Page.REQUESTS
        selectedId = savedInstanceState?.getString("selectedId")
        settingsReturn = Page.values().firstOrNull { it.name == savedInstanceState?.getString("settingsReturn") } ?: Page.REQUESTS
        verificationReturn = Page.values().firstOrNull {
            it.name == savedInstanceState?.getString("verificationReturn") && it != Page.NONE && it != Page.VERIFY
        } ?: Page.PAIRING
        answerRequested = savedInstanceState?.getString("answerRequested")?.takeIf(::validId)
        permissionAnswer = savedInstanceState?.getString("permissionAnswer")?.takeIf(::validId)
        scroll = ScrollView(this).apply { isFillViewport = true; clipToPadding = false }
        column = RadianceUi.column(this).apply { setPadding(dp(16), 0, dp(16), dp(20)) }
        contentTarget = column
        scroll.addView(column)
        callScreen = CallScreen(this, null, app::setSpeakerEnabled, app::hangup, ::openInbox, ::showSettings)
        val panelHeader = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(8))
        }
        panelBack = RadianceUi.button(this, "Back") { navigateBack() }
        panelHeader.addView(panelBack, LinearLayout.LayoutParams(-2, -2))
        panelTitle = RadianceUi.text(this, "Questions", 18, heading = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), 0)
        }
        panelHeader.addView(panelTitle, LinearLayout.LayoutParams(0, -2, 1f))
        panelHangup = RadianceUi.button(this, "Hang up", destructive = true) { if (resumed) app.hangup() }
        panelHeader.addView(panelHangup, LinearLayout.LayoutParams(-2, -2))
        panel = RadianceUi.column(this).apply {
            background = RadianceUi.surface(this@InboxActivity)
            visibility = View.GONE
            addView(panelHeader, LinearLayout.LayoutParams(-1, -2))
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        val overlay = FrameLayout(this).apply {
            addView(panel, FrameLayout.LayoutParams(-1, -1).apply {
                setMargins(dp(12), dp(128), dp(12), dp(12))
            })
        }
        setContentView(FrameLayout(this).apply {
            addView(callScreen, FrameLayout.LayoutParams(-1, -1))
            addView(overlay, FrameLayout.LayoutParams(-1, -1))
        })
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.setSystemBarsAppearance(0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
            overlay.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom); insets
            }
        } else overlay.fitsSystemWindows = true
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT
        ) {
            if (page != Page.NONE && page != Page.REQUESTS) navigateBack()
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
        incomingPair?.let { incomingPair = null; app.pair(it) }
        continueAnswer()
    }
    override fun onPause() {
        resumed = false
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
        outState.putString("verificationReturn", verificationReturn.name)
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

    private fun openPairing() { page = Page.PAIRING; render() }

    private fun showInboxPanel(open: Boolean) {
        panel.visibility = if (open) View.VISIBLE else View.GONE
        panelHangup.visibility = if (app.callId != null) View.VISIBLE else View.GONE
        callScreen.setPanelOpen(open)
        callScreen.compact(open)
        val height = if (open) dp(128) else ViewGroup.LayoutParams.MATCH_PARENT
        if (callScreen.layoutParams.height != height)
            callScreen.layoutParams = (callScreen.layoutParams as FrameLayout.LayoutParams).apply { this.height = height }
    }

    private fun navigateBack() {
        page = when (page) {
            Page.VERIFY -> {
                shownEmoji?.let { app.confirm(it, false) }
                shownEmoji = null
                verificationReturn
            }
            Page.RELAY -> Page.PAIRING
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
            text("Animate the scene, independently of system animation settings.", 14)
            toggle("Reference backdrop", screenPreferences.lightBackdrop) {
                screenPreferences.lightBackdrop = it; callScreen.refreshAppearance()
            }
            text("Rendering", 16, bold = true)
            val quality = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
            val ids = IntArray(3)
            for ((index, label) in arrayOf("Auto", "GPU", "2D").withIndex()) {
                val choice = RadioButton(this).apply {
                    id = View.generateViewId(); text = label; setTextColor(RadianceUi.cream)
                    buttonTintList = RadianceUi.tint
                    minHeight = dp(48)
                    contentDescription = "$label rendering"
                }
                ids[index] = choice.id
                quality.addView(choice, RadioGroup.LayoutParams(0, -2, 1f))
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
            text("Turn off to allow screenshots and screen recording, including captions and pairing details.", 14)
            toggle("Notification previews", app.inviteSettings.showPreview) {
                app.inviteSettings.showPreview = it; app.invitationSettingsChanged()
            }
            text("Previews are private by default. Android lock-screen privacy applies; the public notification stays redacted.", 14)
        }
        card {
            text("Invitations", 20, bold = true)
            toggle("Ringing invitations", app.inviteSettings.callMode) {
                app.inviteSettings.callMode = it; app.invitationSettingsChanged()
            }
            text("Turn off for notification-only invitations. Sound, vibration and Do Not Disturb follow system settings.", 14)
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
        val code = app.verifyEmoji
        if (code != null && shownEmoji != code) {
            if (page != Page.VERIFY) verificationReturn = if (page == Page.NONE) Page.PAIRING else page
            shownEmoji = code
            page = Page.VERIFY
            renderedPage = null
        } else if (code == null && page == Page.VERIFY) {
            shownEmoji = null
            page = if (app.paired) Page.REQUESTS else Page.PAIRING
        }
        showInboxPanel(page != Page.NONE)
        if (page == Page.NONE) { renderedPage = null; return }
        panelBack.text = if (page == Page.SETTINGS) "Done" else "Back"
        panelBack.visibility = if (page == Page.REQUESTS) View.GONE else View.VISIBLE
        panelTitle.text = when (page) {
            Page.REQUESTS -> "Questions"
            Page.PAIRING -> "Pair desktop"
            Page.DETAILS -> "Question details"
            Page.SETTINGS -> "Settings"
            Page.RELAY -> "Restore relay"
            Page.VERIFY -> "Verify desktop"
            Page.NONE -> ""
        }
        // Keep controls, focused input and scroll position stable while gateway state changes.
        if (renderedPage == page && (page == Page.SETTINGS || page == Page.RELAY || page == Page.VERIFY)) return
        val y = if (renderedPage == page && renderedId == selectedId) scroll.scrollY else 0
        renderedPage = page; renderedId = selectedId
        val focused = currentFocus
        saveDrafts()
        column.removeAllViews(); contentTarget = column; transcriptViews = null
        detailViews.keys.retainAll(app.store.state.pending.keys)
        formViews.keys.retainAll(app.store.state.pending.keys)
        when (page) {
            Page.SETTINGS -> renderSettings()
            Page.PAIRING -> renderPairing()
            Page.RELAY -> renderRelay()
            Page.VERIFY -> renderVerification()
            Page.DETAILS -> renderDetails()
            Page.REQUESTS -> renderRequests()
            Page.NONE -> Unit
        }
        if (focused?.isAttachedToWindow == true) focused.requestFocus()
        scroll.post { scroll.scrollTo(0, y) }
    }

    private fun renderRequests() {
        card {
            text(if (app.verifiedInbox) "Questions & answers" else "Questions · Awaiting sync", 26, bold = true)
            text(app.status, 16)
            app.answerReceipt?.let { text(it, 16).accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
            notice?.let { text(it, 14) }
            app.pushWarning?.let { text(it, 14) }
            if (!app.paired) button("Pair desktop") { openPairing() }
            else if (app.needsRelayOrigin) button("Restore relay address") { page = Page.RELAY; render() }
            else if (app.callId == null) button(if (app.verifiedInbox) "Refresh questions" else "Reconnect") { notice = null; app.retry() }
            if (!Invites.allowed(this)) notificationSettings()
            button("Settings") { showSettings() }
            if (app.callId != null) button("Return to voice") { page = Page.NONE; render() }
        }
        val state = app.store.state
        if (state.pending.isEmpty()) card { text(if (app.verifiedInbox) "No pending questions." else "No cached questions.", 17) }
        val rows = state.pending.values.sortedWith(compareByDescending<Pending> { it.id == app.callId }.thenByDescending { it.createdAt })
        for (item in rows) card {
            requestHeading(item)
            if (app.verifiedInbox) text(item.question, 17)
            renderForm(item)
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

    private fun renderForm(item: Pending) {
        val schema = app.forms[item.id]
        if (schema == null || !app.verifiedInbox) {
            text(app.formMessages[item.id] ?: if (app.verifiedInbox) "Loading question…" else "Reconnect to answer.", 16)
            app.loadForm(item.id)
            return
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
                return
            }
        }
        (view.parent as? ViewGroup)?.removeView(view)
        view.availability(app.verifiedInbox && app.idle, item.id in app.submitting, app.formMessages[item.id])
        contentTarget.addView(view, LinearLayout.LayoutParams(-1, -2))
    }

    private fun voiceButton(item: Pending) {
        if (app.forms[item.id]?.optBoolean("voice", true) == false) return
        val control = RadianceUi.button(this, "Answer by voice · Optional") { if (resumed) answer(item.id) }
        control.setCompoundDrawablesWithIntrinsicBounds(android.R.drawable.ic_btn_speak_now, 0, 0, 0)
        control.compoundDrawableTintList = android.content.res.ColorStateList.valueOf(RadianceUi.cream)
        control.compoundDrawablePadding = dp(8)
        control.contentDescription = "Answer by voice: ${if (app.verifiedInbox) item.question else "Pending question"}"
        control.isEnabled = app.verifiedInbox && app.idle && item.id !in app.submitting
        contentTarget.addView(control, RadianceUi.rowParams(this))
    }

    private fun requestHeading(item: Pending) {
        text(if (app.verifiedInbox) item.session?.takeIf { it.isNotBlank() } ?: item.project.ifBlank { "Desktop request" }
            else "Desktop request · Pending sync", 20, bold = true)
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
            if (app.verifiedInbox) text(item.question, 18)
            notice?.let { text(it, 14) }
            renderForm(item)
            val detail = detailViews.getOrPut(item.id) { QuestionDetailView(this) }
            (detail.parent as? ViewGroup)?.removeView(detail)
            detail.bind(item, state.details[item.id], app.verifiedInbox)
            contentTarget.addView(detail, LinearLayout.LayoutParams(-1, -2))
        }
        if (app.callId == item.id) {
            card {
                text("Proposed answer · Not confirmed or submitted", 18, bold = true)
                text(if (app.verifiedInbox) state.proposals[item.id] ?: "No current proposal from the desktop."
                    else "Reconnect to review the current proposed answer.", 17)
            }
            card {
                text("Voice captions · Not a submitted answer", 18, bold = true)
                transcriptViews = CallTranscriptViews(text("", 20, bold = true), text("", 17), text("", 17))
                renderVoice()
                toggle("Speaker", app.speakerEnabled) { app.setSpeakerEnabled(it) }
            }
        }
        voiceButton(item)
        if (item.id !in state.silenced && app.callId != item.id) button("Not now") { app.silence(item.id) }
    }

    private fun renderPairing() {
        card {
            text(if (app.paired) "Your desktop" else "Pair a desktop", 26, bold = true)
            text(app.status, 16)
            notice?.let { text(it, 14) }
            if (!app.paired) {
                text("Use the one-time code shown on your own desktop. Compare every emoji on both screens.", 16)
                if (!app.pairing) {
                    button("Scan pairing QR") { scan() }
                    button("Pair from clipboard") {
                        val clip = getSystemService(ClipboardManager::class.java)?.primaryClip
                        val raw = if (clip != null && clip.itemCount == 1) clip.getItemAt(0).text?.toString() else null
                        if (raw == null) { notice = "Copy the desktop pairing JSON first."; render() }
                        else { notice = null; app.pair(raw) }
                    }
                } else button("Cancel pairing") { app.retry() }
            } else if (app.needsRelayOrigin) {
                text("Relay setup required. Your existing pairing keys are retained.", 16)
                button("Restore relay address") { page = Page.RELAY; render() }
            } else button("Reconnect") { notice = null; app.retry() }
        }
        button("All questions") { page = Page.REQUESTS; render() }
        button("Settings") { showSettings() }
    }

    private fun renderRelay() {
        card {
            text("Existing relay origin", 24, bold = true)
            text("Enter the same trusted HTTPS relay used by your paired desktop. This sends your existing relay credential there; never enter an unfamiliar address.", 16)
            val input = EditText(this).apply {
                hint = "https://relay.example"
                setTextColor(RadianceUi.cream); setHintTextColor(RadianceUi.muted)
                backgroundTintList = android.content.res.ColorStateList.valueOf(RadianceUi.muted)
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                contentDescription = "Trusted HTTPS relay address"
                minHeight = dp(56)
            }
            contentTarget.addView(input, LinearLayout.LayoutParams(-1, -2))
            button("Restore") {
                page = Page.PAIRING
                app.migrateRelayOrigin(input.text.toString())
                render()
            }
            button("Cancel") { page = Page.PAIRING; render() }
        }
    }

    private fun renderVerification() {
        val code = shownEmoji ?: return
        card {
            text("Verify your desktop", 24, bold = true)
            text("Compare all 12 emoji, in order, with the code on the desktop.", 17)
            text(code, 30).apply { contentDescription = "Verification code: $code" }
            text("Only approve if they match exactly.", 17)
            button("Codes match") { app.confirm(code, true) }
            button("Do not match") { app.confirm(code, false) }
        }
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
        notice = null
        IntentIntegrator(this).setCaptureActivity(PairScanActivity::class.java)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt("away · Scan your desktop pairing code. Back to cancel.")
            .setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false).initiateScan()
    }
    @Deprecated("Platform Activity result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result == null) { super.onActivityResult(requestCode, resultCode, data); return }
        val raw = result.contents
        if (raw != null && raw.length <= 8192) {
            if (resumed) app.pair(raw) else incomingPair = raw
        } else notice = "No pairing code read. Check camera permission or use the clipboard."
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
        notice = if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) null
            else if (requestCode == MIC) "Microphone unavailable. You can still answer by touch." else "Questions remain on the home screen."
        if (requestCode == MIC) {
            val id = permissionAnswer; permissionAnswer = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) answerRequested = id
            continueAnswer()
        }
        if (resumed) render()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
    private fun text(value: String, sp: Int, bold: Boolean = false): TextView =
        RadianceUi.text(this, value, sp, bold).also { contentTarget.addView(it) }

    private fun button(label: String, action: () -> Unit) {
        contentTarget.addView(RadianceUi.button(this, label) { if (resumed) action() }, RadianceUi.rowParams(this))
    }

    private fun toggle(label: String, checked: Boolean, changed: (Boolean) -> Unit) {
        contentTarget.addView(Switch(this).apply {
            text = label; textSize = 16f; setTextColor(RadianceUi.cream)
            minHeight = dp(56); setPadding(0, dp(8), 0, dp(8))
            thumbTintList = RadianceUi.tint
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
    private companion object { const val MIC = 1; const val NOTIFICATIONS = 2 }
}

class PairScanActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        ScreenPreferences(this).apply(window)
        super.onCreate(savedInstanceState)
        val header = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = RadianceUi.surface(this@PairScanActivity)
            val padding = RadianceUi.dp(this@PairScanActivity, 12)
            setPadding(padding, padding, padding, padding)
            addView(RadianceUi.text(this@PairScanActivity, "away", 24, heading = true),
                LinearLayout.LayoutParams(0, -2, 1f))
            addView(RadianceUi.button(this@PairScanActivity, "Back") {
                setResult(Activity.RESULT_CANCELED); finish()
            })
        }
        val navigation = FrameLayout(this).apply {
            addView(header, FrameLayout.LayoutParams(-1, -2, Gravity.TOP).apply {
                val margin = RadianceUi.dp(this@PairScanActivity, 16)
                setMargins(margin, margin, margin, 0)
            })
        }
        findViewById<FrameLayout>(android.R.id.content).addView(navigation, FrameLayout.LayoutParams(-1, -1))
        if (Build.VERSION.SDK_INT >= 30) navigation.setOnApplyWindowInsetsListener { view, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        } else navigation.fitsSystemWindows = true
    }
    override fun onResume() {
        super.onResume()
        ScreenPreferences(this).apply(window)
    }
}
