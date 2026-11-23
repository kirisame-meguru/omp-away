package ru.eleven.ompaway

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Switch
import android.widget.TextView
import android.widget.ToggleButton
import android.window.OnBackInvokedDispatcher
import com.google.zxing.integration.android.IntentIntegrator
import com.journeyapps.barcodescanner.CaptureActivity
import java.text.DateFormat
import java.util.Date

class InboxActivity : Activity() {
    private val app get() = application as Gateway
    private lateinit var scroll: ScrollView
    private lateinit var column: LinearLayout
    private lateinit var root: FrameLayout
    private lateinit var callScreen: CallScreen
    private var callSource: CallVisualSource? = null
    private var selectedId: String? = null
    private var incomingPair: String? = null
    private var notice: String? = null
    private var emojiDialog: AlertDialog? = null
    private var shownEmoji: String? = null
    private var resumed = false
    private lateinit var screenPreferences: ScreenPreferences
    private var settingsDialog: AlertDialog? = null
    private var panelOpen = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        screenPreferences = ScreenPreferences(this)
        screenPreferences.apply(window)
        panelOpen = savedInstanceState?.getBoolean("panelOpen") ?: false
        scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(0xff181824.toInt())
            visibility = View.GONE
        }
        column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(8), dp(24), dp(24)) }
        scroll.addView(column)
        callScreen = CallScreen(this, null, app::setSpeakerEnabled, app::hangup, ::openInbox, ::showSettings)
        root = FrameLayout(this).apply {
            addView(callScreen, FrameLayout.LayoutParams(-1, -1))
            addView(scroll, FrameLayout.LayoutParams(-1, -1))
        }
        setContentView(root)
        if (Build.VERSION.SDK_INT >= 30) window.insetsController?.setSystemBarsAppearance(0,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        else @Suppress("DEPRECATION") window.decorView.systemUiVisibility = 0
        if (Build.VERSION.SDK_INT >= 30) scroll.setOnApplyWindowInsetsListener { view, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom); insets
        } else scroll.fitsSystemWindows = true
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT
        ) {
            if (panelOpen) showInboxPanel(false)
            else if (isTaskRoot) moveTaskToBack(true) else finish()
        }
        takeInvite(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); takeInvite(intent); if (resumed) render() }
    private fun takeInvite(intent: Intent) {
        if (intent.action == Invites.OPEN) {
            selectedId = intent.getStringExtra(Invites.ID)?.takeIf(::validId)
            panelOpen = true
        }
    }

    override fun onResume() {
        super.onResume(); resumed = true
        applyScreenPrivacy()
        if (app.callId == null) { callScreen.bind(null); callSource = null }
        callScreen.resume()
        app.foreground(::render, ::renderVoice)
        incomingPair?.let { incomingPair = null; app.pair(it) }
    }
    override fun onPause() {
        resumed = false
        callScreen.pause()
        settingsDialog?.dismiss()
        app.background(); dismissEmoji()
        super.onPause()
    }

    override fun onDestroy() {
        callScreen.dispose()
        settingsDialog?.dismiss()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("panelOpen", panelOpen)
        super.onSaveInstanceState(outState)
    }

    private fun openInbox() {
        panelOpen = true
        render()
    }
    private fun showInboxPanel(open: Boolean) {
        panelOpen = open
        scroll.visibility = if (open) View.VISIBLE else View.GONE
        // Retain the engine, but do not render beneath an opaque inbox.
        if (resumed) { if (open) callScreen.pause() else callScreen.resume() }
    }

    // API 29–32 only; API 33+ uses the OnBackInvokedDispatcher registered in onCreate.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Platform back callback")
    override fun onBackPressed() {
        if (panelOpen) showInboxPanel(false)
        else super.onBackPressed()
    }

    private fun applyScreenPrivacy() {
        screenPreferences.apply(window)
        screenPreferences.apply(emojiDialog?.window)
        screenPreferences.apply(settingsDialog?.window)
    }

    private fun showSettings() {
        if (settingsDialog != null) return
        val settings = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), dp(8))
        }
        fun toggle(label: String, checked: Boolean, changed: (Boolean) -> Unit) {
            settings.addView(Switch(this).apply {
                text = label; textSize = 16f; setTextColor(0xfff4eee4.toInt())
                setPadding(0, dp(12), 0, dp(12))
                isChecked = checked
                setOnCheckedChangeListener { _, enabled -> changed(enabled) }
            }, LinearLayout.LayoutParams(-1, -2))
        }
        toggle("Block screenshots", screenPreferences.blockScreenshots) {
            screenPreferences.blockScreenshots = it
            applyScreenPrivacy()
        }
        settings.addView(TextView(this).apply {
            text = "Turn off to allow screenshots and screen recording, including captions and pairing details."
            textSize = 13f; setTextColor(0xffc5bfcc.toInt())
        })
        toggle("Reduced motion", screenPreferences.reducedMotion) {
            screenPreferences.reducedMotion = it; callScreen.refreshAppearance()
        }
        toggle("Reference backdrop", screenPreferences.lightBackdrop) {
            screenPreferences.lightBackdrop = it; callScreen.refreshAppearance()
        }
        val quality = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        val choices = arrayOf("Auto", "GPU", "2D")
        val ids = IntArray(choices.size)
        for (index in choices.indices) {
            val choice = RadioButton(this).apply {
                id = View.generateViewId(); text = choices[index]
                setTextColor(0xfff4eee4.toInt())
            }
            ids[index] = choice.id
            quality.addView(choice, RadioGroup.LayoutParams(0, -2, 1f))
        }
        quality.check(ids[screenPreferences.quality])
        quality.setOnCheckedChangeListener { _, id ->
            val selected = ids.indexOf(id)
            if (selected >= 0) { screenPreferences.quality = selected; callScreen.refreshAppearance() }
        }
        settings.addView(quality)
        settingsDialog = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Radiance settings")
            .setView(ScrollView(this).apply { addView(settings) })
            .setPositiveButton("Done", null)
            .create().also { dialog ->
                dialog.setOnDismissListener { settingsDialog = null }
                screenPreferences.apply(dialog.window)
                dialog.show()
            }
        applyScreenPrivacy()
    }
    private fun render() {
        if (!resumed || isFinishing) return
        val visual = app.callVisual
        if (visual != null) {
            if (callSource !== visual) {
                callScreen.bind(visual)
                callSource = visual
                showInboxPanel(false)
            }
            callScreen.setSpeaker(app.speakerEnabled)
            renderVoice()
            return
        }
        if (callSource != null) {
            callSource = null
            callScreen.dismiss {
                callScreen.bind(null)
                render()
            }
            return
        }
        callScreen.home(app.paired, app.store.state.pending.size, app.status)
        showInboxPanel(panelOpen)
        val y = scroll.scrollY
        column.removeAllViews()
        button("Back to Radiance") { showInboxPanel(false) }
        text("Away inbox", 28, bold = true)
        text(app.status, 16)
        notice?.let { text(it, 14) }
        app.pushWarning?.let { text(it, 14) }
        column.addView(ToggleButton(this).apply {
            textOn = "Speaker: on"; textOff = "Speaker: off"; isAllCaps = false
            isChecked = app.speakerEnabled
            setTextColor(0xfff4eee4.toInt())
            backgroundTintList = android.content.res.ColorStateList.valueOf(0xff29293b.toInt())
            setOnCheckedChangeListener { _, enabled -> if (resumed) app.setSpeakerEnabled(enabled) }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        if (!Invites.allowed(this)) {
            text("Notifications are off. Open this inbox to see pending requests.", 14)
            button("Enable invitations") {
                if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS) && !askedAndDenied(Manifest.permission.POST_NOTIFICATIONS))
                    ask(Manifest.permission.POST_NOTIFICATIONS, NOTIFICATIONS)
                else if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) appSettings()
                else startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            }
        }
        if (!app.paired) {
            text("Pair a desktop", 22, bold = true)
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
        } else {
            if (app.callId == null) button(if (app.verifiedInbox) "Refresh inbox" else "Reconnect") { notice = null; app.retry() }
        }
        val state = app.store.state
        val selected = selectedId
        if (selected != null && app.verifiedInbox && selected !in state.pending) text("That request is no longer pending.", 16)
        text(if (app.verifiedInbox) "Pending" else "Last known pending", 22, bold = true)
        if (state.pending.isEmpty()) text(if (app.verifiedInbox) "No pending requests." else "No cached requests.", 16)
        // A notification targets the item, never an automatic join or a permission prompt.
        val rows = state.pending.values.sortedWith(compareByDescending<Pending> { it.id == selected }.thenByDescending { it.createdAt })
        for (item in rows) {
            text(item.project, 18, bold = true)
            text(DateFormat.getDateTimeInstance().format(Date(item.createdAt)) + if (item.id in state.silenced) " · Silenced" else "", 14)
            text(item.question, 17)
            if (app.verifiedInbox && app.idle) {
                if (granted(Manifest.permission.RECORD_AUDIO)) button("Answer by voice") { app.join(item.id) }
                else button("Enable microphone to answer") {
                    if (askedAndDenied(Manifest.permission.RECORD_AUDIO)) appSettings() else ask(Manifest.permission.RECORD_AUDIO, MIC)
                }
            }
            if (item.id !in state.silenced && app.callId != item.id) button("Not now") { app.silence(item.id) }
        }
        val awaiting = state.invited.filterNot { it in state.pending }
        if (awaiting.isNotEmpty()) {
            text("Missed invitations", 22, bold = true)
            for (id in awaiting) {
                text(if (id in state.silenced) "Desktop request · Silenced" else "Desktop request · Awaiting sync", 16)
                if (id !in state.silenced) button("Not now") { app.silence(id) }
            }
        }
        scroll.post { scroll.scrollTo(0, y) }
        val code = app.verifyEmoji
        if (code == null) dismissEmoji()
        else if (shownEmoji != code) {
            dismissEmoji(); shownEmoji = code
            emojiDialog = AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert).setTitle("Verify your desktop")
                .setMessage("Compare all 12 emoji, in order, with the code on the desktop:\n\n$code\n\nOnly approve if they match exactly.")
                .setPositiveButton("Codes match") { _, _ -> app.confirm(code, true) }
                .setNegativeButton("Do not match") { _, _ -> app.confirm(code, false) }
                .setOnCancelListener { app.confirm(code, false) }.show()
            screenPreferences.apply(emojiDialog?.window)
        }
    }

    private fun renderVoice() {
        if (!resumed || app.callId == null) return
        callScreen.captions(app.callerCaption, app.callerCaptionFinal,
            app.assistantCaption, app.assistantCaptionFinal)
    }

    private fun dismissEmoji() { emojiDialog?.dismiss(); emojiDialog = null; shownEmoji = null }
    private fun scan() {
        notice = null
        IntentIntegrator(this).setCaptureActivity(PairScanActivity::class.java)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt("Scan the pairing code on your desktop")
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
            else if (requestCode == MIC) "Microphone unavailable. Nothing was joined." else "Invitations remain in the inbox."
        if (resumed) render()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
    private fun text(value: String, sp: Int, bold: Boolean = false): TextView =
        TextView(this).apply {
            text = value; textSize = sp.toFloat(); setPadding(0, dp(if (bold) 14 else 5), 0, dp(3))
            setTextColor(if (bold) 0xfff4eee4.toInt() else 0xffc5bfcc.toInt())
            if (bold) setTypeface(typeface, Typeface.BOLD)
            textDirection = View.TEXT_DIRECTION_FIRST_STRONG
        }.also { column.addView(it) }
    private fun button(label: String, action: () -> Unit) {
        column.addView(Button(this).apply {
            text = label; isAllCaps = false; gravity = Gravity.CENTER; setOnClickListener { if (resumed) action() }
            setTextColor(0xfff4eee4.toInt())
            backgroundTintList = android.content.res.ColorStateList.valueOf(0xff29293b.toInt())
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }
    private companion object { const val MIC = 1; const val NOTIFICATIONS = 2 }
}

class PairScanActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        ScreenPreferences(this).apply(window)
        super.onCreate(savedInstanceState)
    }
    override fun onResume() {
        super.onResume()
        ScreenPreferences(this).apply(window)
    }
}
