package ru.eleven.ompaway

import android.content.Context
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView

/** Plain text only: no HTML, editable controls, choice listeners, or submission capabilities. */
internal class QuestionDetailView(context: Context) : ScrollView(context) {
    private val body = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private var request: Pending? = null
    private var shown: QuestionDisplay? = null
    private var fresh = false
    init {
        isFillViewport = true; addView(body); contentDescription = context.uiString(R.string.read_only_question_and_options)
        isNestedScrollingEnabled = false
        background = RadianceUi.surface(context, RadianceUi.surfaceColor, 8)
        val padding = RadianceUi.dp(context, 16)
        body.setPadding(padding, padding, padding, padding)
    }

    fun bind(item: Pending, display: QuestionDisplay?, verified: Boolean) {
        val safeDisplay = if (verified) display else null
        if (request == item && shown == safeDisplay && fresh == verified) return
        val switched = request?.id != item.id
        request = item; shown = safeDisplay; fresh = verified
        body.removeAllViews()
        label(context.uiString(R.string.question_and_options_read_only), heading = true)
        if (!verified) {
            label(context.uiString(R.string.pending_sync_reconnect_to_read_the_current_question_cached_choices))
        } else if (safeDisplay == null) {
            label(context.uiString(R.string.summary_only_structured_details_are_unavailable_from_this_desktop))
            label(item.question)
        } else {
            if (safeDisplay.context.isNotBlank()) label(safeDisplay.context)
            for ((fieldIndex, field) in safeDisplay.fields.withIndex()) {
                val semantics = when (field.kind) { "single" -> context.uiString(R.string.select_one); "multi" -> context.uiString(R.string.select_multiple); else -> context.uiString(R.string.free_text) }
                label("${fieldIndex + 1}. ${field.label}", heading = true)
                label("$semantics · ${if (field.required) context.uiString(R.string.required) else context.uiString(R.string.optional)}")
                field.description?.takeIf { it.isNotEmpty() }?.let { label(it) }
                for ((optionIndex, option) in field.options.withIndex()) {
                    label("${optionIndex + 1}. ${option.label}${if (option.disabled) context.uiString(R.string.unavailable) else ""}")
                        .tag = "${item.id}/${field.id}/${option.id}"
                }
                if (field.other) label(context.uiString(R.string.other_describe_a_different_answer_by_voice))
                field.inputType?.let { label(context.uiString(R.string.input_type, inputLabel(it))) }
                field.placeholder?.let { label(context.uiString(R.string.input_hint, it)) }
            }
        }
        if (switched || !verified) scrollTo(0, 0)
    }

    private fun inputLabel(type: String): String {
        val resource = when (type) {
            "text" -> R.string.input_text
            "number" -> R.string.input_number
            "range" -> R.string.input_range
            "email" -> R.string.input_email
            "url" -> R.string.input_url
            "date" -> R.string.input_date
            "tel" -> R.string.input_tel
            "time" -> R.string.input_time
            "datetime-local" -> R.string.input_datetime_local
            "month" -> R.string.input_month
            "week" -> R.string.input_week
            else -> return type
        }
        return context.uiString(resource)
    }

    private fun label(value: String, heading: Boolean = false) =
        RadianceUi.text(context, value, if (heading) 18 else 16, heading).apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }.also { body.addView(it, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)) }
}
