package ru.eleven.ompaway

import androidx.appcompat.app.AppCompatActivity
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView

/** Full-screen fallback is private even on the lock screen. Unlock and explicit Answer precede audio. */
class IncomingCallActivity : AppCompatActivity() {
    private val app get() = application as Gateway
    private var id: String? = null
    private val main = Handler(Looper.getMainLooper())
    private var scene: CallScreen? = null
    private val expire = Runnable { id?.let { Invites.cancel(this, it) }; finish() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ScreenPreferences(this).apply(window)
        setShowWhenLocked(true); setTurnScreenOn(true)
        val request = intent.getStringExtra(Invites.ID)?.takeIf(::validId)
        if (request == null || request in app.store.state.closed || request in app.store.state.silenced || request in app.store.state.acknowledged) {
            finish(); return
        }
        id = request
        val sceneView = CallScreen(this, null, {}, {}).also {
            it.setPanelOpen(true)
            scene = it
        }
        val body = RadianceUi.column(this).apply {
            setPadding(RadianceUi.dp(this@IncomingCallActivity, 20), 0,
                RadianceUi.dp(this@IncomingCallActivity, 20), RadianceUi.dp(this@IncomingCallActivity, 12))
        }
        body.addView(RadianceUi.text(this, uiString(R.string.incoming_call), 24, heading = true))
        body.addView(RadianceUi.text(this,
            uiString(R.string.unlock_to_review_the_question_answer_starts_a_voice_call), 16))
        val actions = RadianceUi.column(this).apply {
            val padding = RadianceUi.dp(this@IncomingCallActivity, 16)
            setPadding(padding, 0, padding, padding)
        }
        actions.addView(RadianceUi.button(this, uiString(R.string.answer_call), primary = true) {
                app.acknowledge(request)
                fun open() {
                    startActivity(Intent().setComponent(ComponentName(packageName, "$packageName.AnswerCall"))
                        .setAction(Invites.ANSWER).putExtra(Invites.ID, request)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    finish()
                }
                val keyguard = getSystemService(KeyguardManager::class.java)
                if (keyguard.isKeyguardLocked) keyguard.requestDismissKeyguard(this@IncomingCallActivity,
                    object : KeyguardManager.KeyguardDismissCallback() { override fun onDismissSucceeded() { open() } })
                else open()
        }, RadianceUi.rowParams(this))
        actions.addView(RadianceUi.button(this, uiString(R.string.not_now), destructive = true) {
            app.silence(request); finish()
        }, RadianceUi.rowParams(this))
        val sheet = RadianceUi.column(this).apply {
            background = RadianceUi.surface(this@IncomingCallActivity)
            setPadding(0, RadianceUi.dp(this@IncomingCallActivity, 16), 0, 0)
            addView(body, LinearLayout.LayoutParams(-1, -2))
            addView(actions, LinearLayout.LayoutParams(-1, -2))
        }
        val overlay = FrameLayout(this).apply {
            addView(ScrollView(this@IncomingCallActivity).apply { addView(sheet) },
                FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply {
                val margin = RadianceUi.dp(this@IncomingCallActivity, 16)
                setMargins(margin, margin, margin, margin)
            })
        }
        setContentView(FrameLayout(this).apply {
            addView(sceneView, FrameLayout.LayoutParams(-1, -1))
            addView(overlay, FrameLayout.LayoutParams(-1, -1))
        })
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.setSystemBarsAppearance(0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
            overlay.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                insets
            }
        } else overlay.fitsSystemWindows = true
        val remaining = intent.getLongExtra("expiresAt", 0) - android.os.SystemClock.elapsedRealtime()
        if (remaining <= 0) expire.run() else main.postDelayed(expire, remaining.coerceAtMost(45_000))
    }
    override fun onResume() {
        super.onResume()
        ScreenPreferences(this).apply(window)
        scene?.resume()
        app.observeInvitation {
            val request = id
            if (request == null || request in app.store.state.closed || request in app.store.state.silenced || app.callId != null) finish()
        }
        if (id in app.store.state.closed) finish()
    }
    override fun onPause() { scene?.pause(); app.observeInvitation(null); super.onPause() }
    override fun onDestroy() { scene?.dispose(); main.removeCallbacks(expire); super.onDestroy() }
}
