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
    val cream = 0xfff4f1eb.toInt()
    val muted = 0xffc2bfb8.toInt()
    val disabled = 0xff85827c.toInt()
    val rose = 0xffffa39c.toInt()
    val surfaceColor = 0xfa181817.toInt()
    val cardColor = 0xff242423.toInt()
    val controlColor = 0xff353532.toInt()
    val border = 0xff4b4b46.toInt()
    val textColors = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(disabled, cream))
    private val destructiveColors = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(disabled, rose))
    private val primaryText = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(disabled, 0xff181817.toInt()))
    private val primaryFill = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(controlColor, cream))
    val tint = ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_checked), intArrayOf()),
        intArrayOf(disabled, cream, muted))
    val trackTint = ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
        intArrayOf(0xff77746c.toInt(), border))

    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()

    fun surface(context: Context, color: Int = surfaceColor, radius: Int = 16) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(context, radius).toFloat()
        setStroke(dp(context, 1), border)
    }

    fun column(context: Context, card: Boolean = false) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        if (card) {
            background = surface(context, cardColor, 12)
            val padding = dp(context, 16)
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
        setLineSpacing(dp(context, 4).toFloat(), 1f)
        setPadding(0, dp(context, 4), 0, dp(context, 8))
    }

    fun styleButton(button: Button, quiet: Boolean = false, destructive: Boolean = false, primary: Boolean = false) {
        val context = button.context
        button.isAllCaps = false
        button.gravity = Gravity.CENTER
        button.textSize = 14f
        button.setTextColor(if (primary) primaryText else if (destructive) destructiveColors else textColors)
        button.minHeight = dp(context, 48)
        button.minimumHeight = dp(context, 48)
        button.setPadding(dp(context, 12), dp(context, 8), dp(context, 12), dp(context, 8))
        button.backgroundTintList = null
        val background = surface(context, if (quiet) android.graphics.Color.TRANSPARENT else controlColor, 8)
        if (quiet || primary) background.setStroke(0, border)
        if (primary) background.setColor(primaryFill)
        button.background = RippleDrawable(ColorStateList.valueOf(0x33f4f1eb), background, null)
    }

    fun button(context: Context, label: String, destructive: Boolean = false, primary: Boolean = false, action: () -> Unit) = Button(context).apply {
        text = label
        styleButton(this, quiet = !primary, destructive = destructive, primary = primary)
        setOnClickListener { action() }
    }

    fun rowParams(context: Context) = LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = dp(context, 8)
        bottomMargin = dp(context, 4)
    }
}
