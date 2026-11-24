package ru.eleven.ompaway

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Foreground surfaces shared by requests, pairing, settings and invitations. */
internal object RadianceUi {
    val cream = 0xfff4eee4.toInt()
    val muted = 0xffc5bfcc.toInt()
    val rose = 0xffe9898f.toInt()
    val tint = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
        intArrayOf(cream, 0xff777180.toInt()))

    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()

    fun surface(context: Context, color: Int = 0xee181824.toInt(), radius: Int = 28) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(context, radius).toFloat()
        setStroke(dp(context, 1), 0x26f4eee4)
    }

    fun column(context: Context, card: Boolean = false) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        if (card) {
            background = surface(context, 0xd9242433.toInt(), 22)
            val padding = dp(context, 18)
            setPadding(padding, padding, padding, padding)
        }
    }

    fun text(context: Context, value: String, size: Int = 16, heading: Boolean = false) = TextView(context).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(if (heading) cream else muted)
        typeface = Typeface.create(if (heading) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
        isAccessibilityHeading = heading
        setLineSpacing(dp(context, 3).toFloat(), 1f)
        setPadding(0, dp(context, 5), 0, dp(context, 8))
    }

    fun styleButton(button: Button, quiet: Boolean = false, destructive: Boolean = false) {
        val context = button.context
        button.isAllCaps = false
        button.gravity = Gravity.CENTER
        button.textSize = 14f
        button.setTextColor(if (destructive) rose else cream)
        button.minHeight = dp(context, 48)
        button.minimumHeight = dp(context, 48)
        button.setPadding(dp(context, 12), dp(context, 8), dp(context, 12), dp(context, 8))
        button.backgroundTintList = null
        button.background = RippleDrawable(ColorStateList.valueOf(0x33f4eee4),
            surface(context, if (quiet) 0x00242433 else 0xe6373547.toInt(), 24), null)
    }

    fun button(context: Context, label: String, destructive: Boolean = false, action: () -> Unit) = Button(context).apply {
        text = label
        styleButton(this, destructive = destructive)
        setOnClickListener { action() }
    }

    fun rowParams(context: Context) = LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = dp(context, 8)
        bottomMargin = dp(context, 4)
    }
}
