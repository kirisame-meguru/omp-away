package ru.eleven.ompaway

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/** Keep native refresh semantics, but let the complete inbox panel follow the pull. */
internal class InboxRefreshLayout(context: Context) : SwipeRefreshLayout(context) {
    var panel: View? = null
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val restingOffset = RadianceUi.dp(context, 72).toFloat()
    private val maximumOffset = RadianceUi.dp(context, 128).toFloat()
    private var topInset = -1
    private var pointer = MotionEvent.INVALID_POINTER_ID
    private var childOwnsGesture = false
    private var startY = 0f
    private var nestedPull = 0f

    fun setTopInset(inset: Int) {
        if (topInset == inset) return
        topInset = inset
        setProgressViewOffset(false, -progressCircleDiameter, inset + RadianceUi.dp(context, 24))
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) childOwnsGesture = false
        if (childOwnsGesture) return false
        trackPointer(event)
        return super.onInterceptTouchEvent(event)
    }

    override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
        // The direct child is an inset container; still honor its scrolling descendants.
        childOwnsGesture = disallowIntercept
        super.requestDisallowInterceptTouchEvent(disallowIntercept)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        trackPointer(event)
        val handled = super.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> if (handled && isEnabled && !isRefreshing) {
                val index = event.findPointerIndex(pointer)
                if (index >= 0) panel?.let {
                    it.animate().cancel()
                    it.translationY = ((event.getY(index) - startY - slop) * .5f).coerceIn(0f, maximumOffset)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                pointer = MotionEvent.INVALID_POINTER_ID
                settle()
            }
        }
        return handled
    }

    override fun onNestedScroll(target: View, dxConsumed: Int, dyConsumed: Int,
        dxUnconsumed: Int, dyUnconsumed: Int, type: Int, consumed: IntArray) {
        super.onNestedScroll(target, dxConsumed, dyConsumed, dxUnconsumed, dyUnconsumed, type, consumed)
        if (type == androidx.core.view.ViewCompat.TYPE_TOUCH && isEnabled && !isRefreshing &&
            dyUnconsumed < 0 && !canChildScrollUp()) {
            nestedPull -= dyUnconsumed
            panel?.animate()?.cancel()
            panel?.translationY = nestedPull.coerceAtMost(maximumOffset)
        }
    }

    override fun onNestedPreScroll(target: View, dx: Int, dy: Int, consumed: IntArray, type: Int) {
        super.onNestedPreScroll(target, dx, dy, consumed, type)
        if (type == androidx.core.view.ViewCompat.TYPE_TOUCH && nestedPull > 0 && dy > 0) {
            nestedPull = (nestedPull - dy).coerceAtLeast(0f)
            panel?.translationY = nestedPull.coerceAtMost(maximumOffset)
        }
    }

    override fun onStopNestedScroll(target: View, type: Int) {
        super.onStopNestedScroll(target, type)
        if (type == androidx.core.view.ViewCompat.TYPE_TOUCH) {
            nestedPull = 0f
            settle()
        }
    }

    private fun trackPointer(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pointer = event.getPointerId(0)
                startY = event.getY(0)
            }
            MotionEvent.ACTION_POINTER_DOWN -> switchPointer(event, event.actionIndex)
            MotionEvent.ACTION_POINTER_UP -> if (event.getPointerId(event.actionIndex) == pointer)
                switchPointer(event, if (event.actionIndex == 0) 1 else 0)
        }
    }

    private fun switchPointer(event: MotionEvent, next: Int) {
        val previous = event.findPointerIndex(pointer)
        if (previous >= 0) startY += event.getY(next) - event.getY(previous)
        else startY = event.getY(next)
        pointer = event.getPointerId(next)
    }

    override fun setRefreshing(refreshing: Boolean) {
        val changed = isRefreshing != refreshing
        super.setRefreshing(refreshing)
        if (changed) settle()
    }

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        if (!enabled) panel?.let {
            it.animate().cancel()
            it.translationY = 0f
        }
    }

    private fun settle() {
        panel?.animate()?.translationY(if (isEnabled && isRefreshing) restingOffset else 0f)
            ?.setDuration(180)?.start()
    }

    override fun onDetachedFromWindow() {
        panel?.animate()?.cancel()
        panel?.translationY = 0f
        super.onDetachedFromWindow()
    }
}
