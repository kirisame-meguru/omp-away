package ru.eleven.ompaway

import android.animation.ValueAnimator
import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.widget.FrameLayout
import android.widget.TextView

/** Transient foreground feedback; never a list item or part of pull-to-refresh. */
internal class ReceiptToast(context: Context) : FrameLayout(context) {
    private val label = TextView(context).apply {
        textSize = 16f
        setTextColor(RadianceUi.cream)
        background = RadianceUi.surface(context, RadianceUi.surfaceColor, 24)
        setPadding(dp(20), dp(12), dp(20), dp(12))
        elevation = dp(8).toFloat()
        gravity = Gravity.CENTER
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private var motion = false
    private val hide = Runnable {
        if (motion) label.animate().alpha(0f).translationY(dp(12).toFloat()).setDuration(160)
            .withEndAction { dismiss() }.start()
        else dismiss()
    }

    init {
        visibility = GONE
        isClickable = false
        isFocusable = false
        setPadding(dp(24), dp(16), dp(24), dp(24))
        addView(label, LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
    }

    fun show(message: String, animations: Boolean) {
        removeCallbacks(hide)
        label.animate().withEndAction(null).cancel()
        motion = animations && ValueAnimator.areAnimatorsEnabled()
        label.text = message
        visibility = VISIBLE
        label.alpha = if (motion) 0f else 1f
        label.translationY = if (motion) dp(12).toFloat() else 0f
        if (motion) label.animate().alpha(1f).translationY(0f).setDuration(200).start()
        val accessibility = context.getSystemService(AccessibilityManager::class.java)
        val duration = accessibility.getRecommendedTimeoutMillis(4000, AccessibilityManager.FLAG_CONTENT_TEXT)
        postDelayed(hide, duration.toLong())
    }

    fun dismiss() {
        removeCallbacks(hide)
        label.animate().withEndAction(null).cancel()
        visibility = GONE
        label.text = ""
    }

    override fun onDetachedFromWindow() {
        dismiss()
        super.onDetachedFromWindow()
    }

    private fun dp(value: Int) = RadianceUi.dp(context, value)
}
