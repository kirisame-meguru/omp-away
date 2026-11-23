package ru.eleven.ompaway

import android.content.Context
import android.graphics.Typeface
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Plain text only: no HTML, editable controls, choice listeners, or submission capabilities. */
internal class QuestionDetailView(context: Context) : ScrollView(context) {
    private val body = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private var request: Pending? = null
    private var shown: QuestionDisplay? = null
    private var fresh = false
    init { isFillViewport = true; addView(body); contentDescription = "Read-only question and options" }

    fun bind(item: Pending, display: QuestionDisplay?, verified: Boolean) {
        val safeDisplay = if (verified) display else null
        if (request == item && shown == safeDisplay && fresh == verified) return
        val switched = request?.id != item.id
        request = item; shown = safeDisplay; fresh = verified
        body.removeAllViews()
        label("Question and options · Read only", heading = true)
        if (!verified) {
            label("Pending sync. Reconnect to read the current question; cached choices are unavailable.")
        } else if (safeDisplay == null) {
            label("Summary only — structured details are unavailable from this desktop.")
            label(item.question)
        } else {
            if (safeDisplay.context.isNotBlank()) label(safeDisplay.context)
            for ((fieldIndex, field) in safeDisplay.fields.withIndex()) {
                val semantics = when (field.kind) { "single" -> "Select one"; "multi" -> "Select multiple"; else -> "Free text" }
                label("${fieldIndex + 1}. ${field.label}", heading = true)
                label("$semantics · ${if (field.required) "Required" else "Optional"}")
                field.description?.takeIf { it.isNotEmpty() }?.let { label(it) }
                for ((optionIndex, option) in field.options.withIndex()) {
                    label("${optionIndex + 1}. ${option.label}${if (option.disabled) " · Unavailable" else ""}")
                        .tag = "${item.id}/${field.id}/${option.id}"
                }
                if (field.other) label("Other · Describe a different answer by voice")
                field.inputType?.let { label("Input: $it") }
                field.placeholder?.let { label("Hint: $it") }
            }
        }
        if (switched || !verified) scrollTo(0, 0)
    }

    private fun label(value: String, heading: Boolean = false) = TextView(context).apply {
        text = value; textSize = if (heading) 18f else 17f
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        isAccessibilityHeading = heading
        setPadding(0, (8 * resources.displayMetrics.density).toInt(), 0, 0)
        if (heading) setTypeface(typeface, Typeface.BOLD)
    }.also { body.addView(it, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)) }
}
