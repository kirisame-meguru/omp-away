package ru.eleven.ompaway

import android.app.Activity
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Full-screen fallback is private even on the lock screen. Unlock and explicit Answer precede audio. */
class IncomingCallActivity : Activity() {
    private val app get() = application as Gateway
    private var id: String? = null
    private val main = Handler(Looper.getMainLooper())
    private val expire = Runnable { id?.let { Invites.cancel(this, it) }; finish() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setShowWhenLocked(true); setTurnScreenOn(true)
        val request = intent.getStringExtra(Invites.ID)?.takeIf(::validId)
        if (request == null || request in app.store.state.closed || request in app.store.state.silenced || request in app.store.state.acknowledged) {
            finish(); return
        }
        id = request
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
        }
        body.addView(TextView(this).apply { text = "Incoming Away call"; textSize = 28f; isAccessibilityHeading = true })
        body.addView(TextView(this).apply { text = "Desktop request. Unlock to review the private question. Answering starts voice, not form submission."; textSize = 18f })
        body.addView(Button(this).apply {
            text = "Answer call"; isAllCaps = false
            setOnClickListener {
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
            }
        })
        body.addView(Button(this).apply {
            text = "Decline"; isAllCaps = false
            setOnClickListener { app.silence(request); finish() }
        })
        setContentView(ScrollView(this).apply { addView(body) })
        val remaining = intent.getLongExtra("expiresAt", 0) - android.os.SystemClock.elapsedRealtime()
        if (remaining <= 0) expire.run() else main.postDelayed(expire, remaining.coerceAtMost(45_000))
    }
    override fun onResume() {
        super.onResume()
        app.observeInvitation {
            val request = id
            if (request == null || request in app.store.state.closed || request in app.store.state.silenced || app.callId != null) finish()
        }
        if (id in app.store.state.closed) finish()
    }
    override fun onPause() { app.observeInvitation(null); super.onPause() }
    override fun onDestroy() { main.removeCallbacks(expire); super.onDestroy() }
}
