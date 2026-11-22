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
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.ToggleButton
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
    private var emojiDialog: AlertDialog? = null
    private var shownEmoji: String? = null
    private var resumed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        scroll = ScrollView(this).apply { isFillViewport = true }
        column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(24)) }
        scroll.addView(column); setContentView(scroll)
        if (Build.VERSION.SDK_INT >= 30) scroll.setOnApplyWindowInsetsListener { view, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom); insets
        }
        takeInvite(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); takeInvite(intent); if (resumed) render() }
    private fun takeInvite(intent: Intent) {
        if (intent.action == Invites.OPEN) selectedId = intent.getStringExtra(Invites.ID)?.takeIf(::validId)
    }

    override fun onResume() {
        super.onResume(); resumed = true
        app.foreground(::render)
        incomingPair?.let { incomingPair = null; app.pair(it) }
    }
    override fun onPause() {
        resumed = false
        app.background(); dismissEmoji()
        super.onPause()
    }

    private fun render() {
        if (!resumed || isFinishing) return
        val y = scroll.scrollY
        column.removeAllViews()
        text("Away inbox", 28, bold = true)
        text(app.status, 16)
        notice?.let { text(it, 14) }
        app.pushWarning?.let { text(it, 14) }
        column.addView(ToggleButton(this).apply {
            textOn = "Speaker: on"; textOff = "Speaker: off"; isAllCaps = false
            isChecked = app.speakerEnabled
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
            app.callId?.let {
                text(if (app.talking) "Microphone and playback on" else "Waiting for desktop to join", 20, bold = true)
                button("Hang up") { app.hangup() }
            }
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
            emojiDialog = AlertDialog.Builder(this).setTitle("Verify your desktop")
                .setMessage("Compare all 12 emoji, in order, with the code on the desktop:\n\n$code\n\nOnly approve if they match exactly.")
                .setPositiveButton("Codes match") { _, _ -> app.confirm(code, true) }
                .setNegativeButton("Do not match") { _, _ -> app.confirm(code, false) }
                .setOnCancelListener { app.confirm(code, false) }.show()
        }
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
    private fun text(value: String, sp: Int, bold: Boolean = false) {
        column.addView(TextView(this).apply {
            text = value; textSize = sp.toFloat(); setPadding(0, dp(if (bold) 14 else 5), 0, dp(3))
            if (bold) setTypeface(typeface, Typeface.BOLD)
            textDirection = View.TEXT_DIRECTION_FIRST_STRONG
        })
    }
    private fun button(label: String, action: () -> Unit) {
        column.addView(Button(this).apply {
            text = label; isAllCaps = false; gravity = Gravity.CENTER; setOnClickListener { if (resumed) action() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }
    private companion object { const val MIC = 1; const val NOTIFICATIONS = 2 }
}

class PairScanActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
    }
}
