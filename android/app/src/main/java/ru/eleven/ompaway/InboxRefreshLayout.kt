package ru.eleven.ompaway

import android.animation.ValueAnimator
import android.content.Context
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import kotlin.math.abs
import kotlin.math.min

/** One indicator owns both connection feedback and the whole-panel refresh gesture. */
internal class InboxRefreshLayout(context: Context) : FrameLayout(context) {
    var panel: View? = null
    var canScrollUp: () -> Boolean = { false }
    var onRefresh: (() -> Boolean)? = null
    private val indicator = InboxStatusIndicator(context)
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val restingOffset = RadianceUi.dp(context, 72).toFloat()
    private val maximumOffset = RadianceUi.dp(context, 128).toFloat()
    private val threshold = RadianceUi.dp(context, 128).toFloat()
    private var topInset = 0
    private var offset = 0f
    private var originOffset = 0f
    private var distance = 0f
    private var pointer = MotionEvent.INVALID_POINTER_ID
    private var startY = 0f
    private var startX = 0f
    private var dragging = false
    private var nested = false
    private var pulling = false
    private var cancelledGesture = false
    private var touchActive = false
    private var active = false
    private var animations = true
    private var connection = Gateway.InboxConnection.DISCONNECTED
    private var displayed: Gateway.InboxConnection? = null
    private var detail = ""
    private val busy get() = connection == Gateway.InboxConnection.CONNECTING || connection == Gateway.InboxConnection.REFRESHING
    private val hideSuccess = Runnable { if (active && connection == Gateway.InboxConnection.CONNECTED && !dragging && distance == 0f) settle(0f) }
    private val motion = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 260
        interpolator = DecelerateInterpolator(1.5f)
        addUpdateListener { place(it.animatedValue as Float) }
    }

    init {
        addView(indicator, LayoutParams(-2, RadianceUi.dp(context, 48), Gravity.TOP or Gravity.CENTER_HORIZONTAL))
        indicator.visibility = GONE
        indicator.setOnClickListener { requestRefresh() }
    }

    fun setContent(content: View) { addView(content, 0, LayoutParams(-1, -1)) }
    fun setTopInset(inset: Int) { topInset = inset; place(offset) }

    fun update(show: Boolean, state: Gateway.InboxConnection, description: String, allowAnimations: Boolean) {
        connection = state
        detail = description
        animations = allowAnimations && ValueAnimator.areAnimatorsEnabled()
        if (!show) { pause(); return }
        active = true
        indicator.isEnabled = isEnabled && !busy
        if (dragging || pulling) {
            if (isEnabled && !busy) return
            dragging = false; pulling = false; distance = 0f; pointer = MotionEvent.INVALID_POINTER_ID
            displayed = null
        }
        if (displayed != state) present()
        else if (state == Gateway.InboxConnection.DISCONNECTED)
            indicator.show(InboxStatusIndicator.Kind.ERROR, "Not connected", "Not connected. $detail", animations)
    }

    fun pause() {
        active = false; displayed = null; dragging = false; nested = false; pulling = false
        touchActive = false
        distance = 0f; pointer = MotionEvent.INVALID_POINTER_ID
        removeCallbacks(hideSuccess); motion.cancel(); place(0f)
    }

    private fun present() {
        displayed = connection
        removeCallbacks(hideSuccess)
        val kind = when (connection) {
            Gateway.InboxConnection.CONNECTED -> InboxStatusIndicator.Kind.SUCCESS
            Gateway.InboxConnection.DISCONNECTED -> InboxStatusIndicator.Kind.ERROR
            else -> InboxStatusIndicator.Kind.BUSY
        }
        val label = when (connection) {
            Gateway.InboxConnection.CONNECTING -> "Connecting…"
            Gateway.InboxConnection.REFRESHING -> "Refreshing…"
            Gateway.InboxConnection.CONNECTED -> "Connected!"
            Gateway.InboxConnection.DISCONNECTED -> "Not connected"
        }
        indicator.show(kind, label, if (kind == InboxStatusIndicator.Kind.ERROR) "$label. $detail" else label, animations)
        settle(restingOffset)
        if (connection == Gateway.InboxConnection.CONNECTED) postDelayed(hideSuccess, 1600)
    }

    private fun requestRefresh() {
        if (!active || !isEnabled || busy) return
        removeCallbacks(hideSuccess)
        displayed = null
        indicator.show(InboxStatusIndicator.Kind.BUSY, "Refreshing…", "Refreshing…", animations)
        settle(restingOffset)
        if (onRefresh?.invoke() != true) present()
    }

    private fun pull(raw: Float) {
        motion.cancel(); removeCallbacks(hideSuccess)
        if (!pulling) {
            originOffset = offset
            indicator.show(InboxStatusIndicator.Kind.BUSY, "Pull to refresh", "Pull to refresh", animations)
            pulling = true
        }
        distance = raw.coerceAtLeast(0f)
        place((originOffset + distance * .5f).coerceAtMost(maximumOffset))
    }

    private fun release(cancelled: Boolean) {
        val refresh = !cancelled && distance >= threshold
        distance = 0f; dragging = false; pulling = false; pointer = MotionEvent.INVALID_POINTER_ID
        if (refresh) requestRefresh()
        else if (connection == Gateway.InboxConnection.CONNECTED) { displayed = connection; settle(0f) }
        else if (active) present()
    }

    private fun settle(target: Float) {
        motion.cancel()
        if (!animations || offset == target) { place(target); return }
        motion.setFloatValues(offset, target); motion.start()
    }

    private fun place(value: Float) {
        offset = value
        panel?.translationY = value
        val height = indicator.measuredHeight.takeIf { it > 0 } ?: RadianceUi.dp(context, 48)
        val end = topInset + RadianceUi.dp(context, 20).toFloat()
        indicator.translationY = if (value <= restingOffset) -height + (end + height) * value / restingOffset
            else end + (value - restingOffset) * .5f
        indicator.alpha = (value / restingOffset).coerceIn(0f, 1f)
        indicator.visibility = if (value > 0f) VISIBLE else GONE
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        place(offset)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            touchActive = true
            cancelledGesture = false
        } else if (event.actionMasked == MotionEvent.ACTION_CANCEL) cancelledGesture = true
        return try { super.dispatchTouchEvent(event) } finally {
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL)
                touchActive = false
        }
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (!active || !isEnabled || busy || nested) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pointer = event.getPointerId(0); startY = event.y; startX = event.x
                originOffset = offset; dragging = false; distance = 0f
            }
            MotionEvent.ACTION_MOVE -> {
                val index = event.findPointerIndex(pointer)
                if (index >= 0 && !canScrollUp()) {
                    val dy = event.getY(index) - startY
                    if (dy > slop && dy > abs(event.getX(index) - startX)) {
                        dragging = true
                        parent?.requestDisallowInterceptTouchEvent(true)
                        return true
                    }
                }
            }
            MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_POINTER_DOWN -> trackPointer(event)
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> pointer = MotionEvent.INVALID_POINTER_ID
        }
        return dragging
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!active || !isEnabled || busy) return false
        trackPointer(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val index = event.findPointerIndex(pointer)
                if (index < 0) return false
                val dy = event.getY(index) - startY
                if (!dragging) {
                    if (canScrollUp() || dy <= slop || dy <= abs(event.getX(index) - startX)) return true
                    dragging = true
                    parent?.requestDisallowInterceptTouchEvent(true)
                }
                pull(dy - slop)
            }
            MotionEvent.ACTION_UP -> if (dragging) release(false)
            MotionEvent.ACTION_CANCEL -> if (dragging) release(true)
        }
        return true
    }

    private fun trackPointer(event: MotionEvent) {
        val next = when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> event.actionIndex
            MotionEvent.ACTION_POINTER_UP -> if (event.getPointerId(event.actionIndex) == pointer)
                if (event.actionIndex == 0) 1 else 0 else return
            else -> return
        }
        val previous = event.findPointerIndex(pointer)
        if (previous >= 0) { startY += event.getY(next) - event.getY(previous); startX += event.getX(next) - event.getX(previous) }
        else { startY = event.getY(next); startX = event.getX(next) }
        pointer = event.getPointerId(next)
    }

    // The inbox uses framework ScrollViews; retain a continuous pull when one reaches its top.
    override fun onStartNestedScroll(child: View, target: View, axes: Int) = touchActive && active && isEnabled && !busy && axes and SCROLL_AXIS_VERTICAL != 0
    override fun onNestedScrollAccepted(child: View, target: View, axes: Int) {
        nested = true; distance = 0f; originOffset = offset
    }
    override fun getNestedScrollAxes() = if (nested) SCROLL_AXIS_VERTICAL else SCROLL_AXIS_NONE
    override fun onNestedScroll(target: View, dxConsumed: Int, dyConsumed: Int, dxUnconsumed: Int, dyUnconsumed: Int) {
        if (touchActive && active && isEnabled && !busy && dyUnconsumed < 0 && !canScrollUp()) pull(distance - dyUnconsumed)
    }
    override fun onNestedPreScroll(target: View, dx: Int, dy: Int, consumed: IntArray) {
        if (dy > 0 && distance > 0f) {
            val used = min(distance, dy.toFloat()).toInt()
            consumed[1] += used
            pull(distance - used)
        }
    }
    override fun onStopNestedScroll(target: View) { nested = false; if (pulling) release(cancelledGesture) }
    override fun onNestedFling(target: View, velocityX: Float, velocityY: Float, consumed: Boolean) = false
    override fun onNestedPreFling(target: View, velocityX: Float, velocityY: Float) = distance > 0f
    override fun onDetachedFromWindow() { pause(); super.onDetachedFromWindow() }
}
