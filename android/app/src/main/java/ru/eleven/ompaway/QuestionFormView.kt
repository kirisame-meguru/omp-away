package ru.eleven.ompaway

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.InputType
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.View
import android.widget.CheckBox
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Native controls only. Agent-provided markup never runs scripts or loads remote resources. */
internal class QuestionFormView(
    context: Context,
    val schema: JSONObject,
    draft: JSONObject?,
    private val noteDraft: JSONArray?,
    submit: (JSONObject, JSONArray) -> Unit,
) : LinearLayout(context) {
    private val readers = linkedMapOf<String, () -> Any?>()
    private val noteReaders = mutableListOf<() -> JSONObject?>()
    private val inputs = mutableListOf<View>()
    private val validators = mutableListOf<() -> String?>()
    private val message = label("")
    private val send = RadianceUi.button(context, context.uiString(R.string.submit_answer), primary = true) {
        val error = validators.firstNotNullOfOrNull { it() }
        if (error == null) submit(values(), notes())
        else {
            message.text = error
            message.visibility = VISIBLE
            message.announceForAccessibility(error)
        }
    }

    init {
        orientation = VERTICAL
        isSaveEnabled = false // Drafts live only in application memory, never instance-state parcels.
        isSaveFromParentEnabled = false
        val contextTitle = schema.optString("title")
        val description = schema.optString("description")
        val titleKey = normalized(contextTitle)
        val descriptionKey = normalized(description)
        var titleInContent = false
        var descriptionInContent = false
        fun authored(text: CharSequence) {
            if ((titleKey.isEmpty() || titleInContent) && (descriptionKey.isEmpty() || descriptionInContent)) return
            val key = normalized(text)
            if (key == titleKey) titleInContent = true
            if (key == descriptionKey) descriptionInContent = true
        }
        val sections = schema.getJSONArray("sections")
        for (i in 0 until sections.length()) {
            val section = sections.getJSONObject(i)
            val title = spans(section.optJSONArray("title"))
            val blocks = section.getJSONArray("blocks")
            var fieldCount = 0
            var singleField: JSONObject? = null
            for (j in 0 until blocks.length()) {
                val block = blocks.getJSONObject(j)
                if (block.getString("kind") == "field") {
                    fieldCount++
                    singleField = block.getJSONObject("field")
                }
            }
            // A fieldset's legend already labels its sole field. Multiple independent fields
            // retain their own captions, even when their labels happen to be identical.
            val sharedCaption = singleField?.takeIf {
                fieldCount == 1 && title.isNotBlank() &&
                    normalized(it.optString("question", it.getString("name"))) == normalized(title)
            }
            if (title.isNotEmpty()) {
                authored(title)
                val caption = if (sharedCaption?.optBoolean("required") == true)
                    SpannableStringBuilder(title).append(" *") else title
                addView(label(caption, true))
            }
            for (j in 0 until blocks.length()) {
                val block = blocks.getJSONObject(j)
                when (block.getString("kind")) {
                    "text" -> {
                        val text = spans(block.getJSONArray("spans"))
                        authored(text)
                        addView(label(text, block.optBoolean("heading")))
                    }
                    "pre" -> addView(HorizontalScrollView(context).apply {
                        addView(label(block.getString("text")).apply { typeface = Typeface.MONOSPACE })
                    })
                    "list" -> {
                        val items = block.getJSONArray("items")
                        for (k in 0 until items.length()) addView(label("${if (block.optBoolean("ordered")) "${k + 1}." else "•"} ${spans(items.getJSONArray(k))}"))
                    }
                    "table" -> {
                        val table = TableLayout(context)
                        val rows = block.getJSONArray("rows")
                        for (k in 0 until rows.length()) {
                            val cells = rows.getJSONArray(k)
                            val row = TableRow(context)
                            for (c in 0 until cells.length()) row.addView(label(spans(cells.getJSONArray(c)), k < block.optInt("headerRows")).apply {
                                minWidth = dp(140); maxWidth = dp(280); setPadding(dp(8), dp(8), dp(8), dp(8))
                            })
                            table.addView(row)
                        }
                        addView(HorizontalScrollView(context).apply { addView(table) })
                    }
                    "field" -> {
                        val definition = block.getJSONObject("field")
                        if (definition !== sharedCaption)
                            authored(definition.optString("question", definition.getString("name")))
                        field(definition, draft, showCaption = definition !== sharedCaption)
                    }
                    "image", "svg" -> addView(label(block.optString("alt").ifBlank { context.uiString(R.string.image) } + context.uiString(R.string.view_on_desktop)))
                }
            }
        }
        // Metadata may repeat authored content, but authored paragraphs/sections are never removed.
        var metadataIndex = 0
        if (contextTitle.isNotBlank() && !titleInContent) addView(label(contextTitle, true), metadataIndex++)
        if (description.isNotBlank() && !descriptionInContent &&
            (titleInContent || descriptionKey != titleKey)) addView(label(description), metadataIndex)
        if (childCount == 0) throw JSONException("Empty touch form")
        message.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        addView(message); addView(send, RadianceUi.rowParams(context))
    }

    fun availability(enabled: Boolean, busy: Boolean, text: String?, canSubmit: Boolean = enabled) {
        send.isEnabled = enabled && canSubmit && !busy
        for (input in inputs) input.isEnabled = enabled && !busy
        send.text = if (busy) context.uiString(R.string.awaiting_desktop_confirmation) else context.uiString(R.string.submit_answer)
        message.text = text.orEmpty()
        message.visibility = if (text.isNullOrEmpty()) GONE else VISIBLE
    }

    fun values() = JSONObject().also { result -> readers.forEach { (name, read) -> read()?.let { result.put(name, it) } } }
    fun notes() = JSONArray().also { result -> noteReaders.forEach { read -> read()?.let { result.put(it) } } }

    private fun field(field: JSONObject, draft: JSONObject?, showCaption: Boolean) {
        val name = field.getString("name")
        val caption = field.optString("question", name) + if (field.optBoolean("required")) " *" else ""
        if (showCaption) addView(label(caption, true))
        if (field.getString("kind") == "text") {
            val edit = editor(field.optBoolean("multiline"))
            edit.contentDescription = caption
            // Keep authored instructions readable without changing single-line or numeric input.
            val placeholder = field.optString("placeholder")
            if (placeholder.isNotBlank()) addView(label(placeholder))
            edit.inputType = when (field.optString("type")) {
                "number", "range" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
                "email" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                "url" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                "date" -> InputType.TYPE_CLASS_DATETIME or InputType.TYPE_DATETIME_VARIATION_DATE
                else -> edit.inputType
            }
            edit.setText(if (draft?.has(name) == true) draft.get(name).toString() else field.optString("value"))
            if (field.optBoolean("multiline")) edit.minLines = field.optInt("rows", 3).coerceIn(2, 8)
            readers[name] = { edit.text.toString() }
            val type = field.optString("type")
            val numeric = type == "number" || type == "range"
            validators.add {
                val value = edit.text.toString()
                val number = if (numeric) value.toDoubleOrNull() else null
                val error = when {
                    field.optBoolean("required") && value.isBlank() -> context.uiString(R.string.enter_an_answer)
                    value.isNotEmpty() && field.has("minLength") && value.length < field.optInt("minLength") ->
                        resources.getQuantityString(R.plurals.minimum_characters, field.optInt("minLength"), field.optInt("minLength"))
                    field.has("maxLength") && value.length > field.optInt("maxLength") ->
                        resources.getQuantityString(R.plurals.maximum_characters, field.optInt("maxLength"), field.optInt("maxLength"))
                    numeric && value.isNotBlank() && (number == null || !number.isFinite()) -> context.uiString(R.string.enter_a_valid_number)
                    numeric && number != null && field.has("min") && number < field.optDouble("min") ->
                        context.uiString(R.string.number_minimum, field.get("min"))
                    numeric && number != null && field.has("max") && number > field.optDouble("max") ->
                        context.uiString(R.string.number_maximum, field.get("max"))
                    else -> null
                }
                edit.error = error
                if (error != null) edit.requestFocus()
                error?.let { "$caption: $it" }
            }
            addView(edit, LayoutParams(-1, -2))
            return
        }
        val multi = field.optBoolean("multi")
        val options = field.getJSONArray("options")
        val group = if (multi) LinearLayout(context).apply { orientation = VERTICAL } else RadioGroup(context)
        val controls = mutableListOf<Pair<CompoundButton, String>>()
        val values = if (draft?.has(name) == true) {
            val raw = draft.get(name)
            if (raw is JSONArray) (0 until raw.length()).map { raw.getString(it) } else listOf(raw.toString())
        } else emptyList()
        var initial: RadioButton? = null
        for (i in 0 until options.length()) {
            val option = options.getJSONObject(i)
            val value = option.getString("value")
            val control = if (multi) CheckBox(context) else RadioButton(context)
            control.id = View.generateViewId()
            control.text = spans(option.getJSONArray("label")).ifEmpty { value }
            control.contentDescription = "$caption: ${control.text}"
            control.setTextColor(RadianceUi.textColors); control.buttonTintList = RadianceUi.tint; control.textSize = 16f
            control.minHeight = dp(48); control.isEnabled = !option.optBoolean("disabled")
            if (control.isEnabled) inputs.add(control)
            val checked = control.isEnabled && if (draft != null) value in values else option.optBoolean("checked")
            if (multi) control.isChecked = checked
            else if (checked) initial = control as RadioButton
            group.addView(control, LayoutParams(-1, -2)); controls.add(control to value)
        }
        var other: CompoundButton? = null
        var otherText: EditText? = null
        if (field.optBoolean("other")) {
            val custom = values.firstOrNull { value -> controls.none { it.second == value } }
            other = if (multi) CheckBox(context) else RadioButton(context)
            other.id = View.generateViewId(); other.text = context.uiString(R.string.other); other.setTextColor(RadianceUi.textColors)
            other.contentDescription = context.uiString(R.string.field_other, caption)
            other.buttonTintList = RadianceUi.tint; other.minHeight = dp(48); other.textSize = 16f
            inputs.add(other)
            group.addView(other, LayoutParams(-1, -2))
            if (multi) other.isChecked = custom != null else if (custom != null) initial = other as RadioButton
            otherText = editor(false).apply { hint = context.uiString(R.string.your_answer); contentDescription = context.uiString(R.string.field_other, caption); setText(custom.orEmpty()) }
        }
        addView(group, LayoutParams(-1, -2))
        if (!multi) (group as RadioGroup).check(initial?.id ?: -1)
        if (otherText != null) {
            addView(otherText, LayoutParams(-1, -2))
            otherText.visibility = if (other?.isChecked == true) VISIBLE else GONE
        }
        readers[name] = {
            val selected = mutableListOf<String>()
            for ((control, value) in controls) if (control.isChecked) selected.add(value)
            if (other?.isChecked == true) otherText?.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { selected.add(it) }
            if (field.optBoolean("array")) JSONArray(selected) else selected.firstOrNull()
        }
        validators.add {
            when {
                other?.isChecked == true && otherText?.text.isNullOrBlank() -> context.uiString(R.string.enter_other_answer, caption)
                field.optBoolean("required") && controls.none { it.first.isChecked } && other?.isChecked != true ->
                    context.uiString(R.string.select_answer, caption)
                else -> null
            }
        }
        val noteRows = mutableListOf<Pair<CompoundButton, EditText>>()
        if (schema.optBoolean("optionNotes")) {
            fun note(control: CompoundButton, value: () -> String) {
                var saved = ""
                if (noteDraft != null) for (i in 0 until noteDraft.length()) {
                    val prior = noteDraft.getJSONObject(i)
                    if (prior.optString("name") == name && prior.optString("value") == value()) saved = prior.optString("text")
                }
                val edit = editor(true).apply {
                    hint = if (multi) context.uiString(R.string.notes_for, control.text) else context.uiString(R.string.notes)
                    contentDescription = context.uiString(R.string.notes_for, control.text)
                    minLines = 1
                    minHeight = dp(48)
                    gravity = android.view.Gravity.TOP or android.view.Gravity.START
                    setText(saved)
                }
                addView(edit, RadianceUi.rowParams(context)); noteRows.add(control to edit)
                noteReaders.add {
                    val text = edit.text.toString()
                    if (control.isChecked && text.isNotBlank() && value().isNotBlank())
                        JSONObject().put("name", name).put("value", value()).put("text", text)
                    else null
                }
            }
            for ((control, value) in controls) if (control.isEnabled) note(control) { value }
            other?.let { note(it) { otherText?.text?.toString()?.trim().orEmpty() } }
        }
        fun selectionChanged() {
            otherText?.visibility = if (other?.isChecked == true) VISIBLE else GONE
            for ((control, row) in noteRows) row.visibility = if (control.isChecked) VISIBLE else GONE
        }
        selectionChanged()
        if (group is RadioGroup) group.setOnCheckedChangeListener { _, _ -> selectionChanged() }
        else {
            for ((control, _) in controls) control.setOnCheckedChangeListener { _, _ -> selectionChanged() }
            other?.setOnCheckedChangeListener { _, _ -> selectionChanged() }
        }
    }

    private fun editor(multiline: Boolean) = EditText(context).apply {
        setTextColor(RadianceUi.textColors); setHintTextColor(RadianceUi.muted); textSize = 16f
        backgroundTintList = android.content.res.ColorStateList.valueOf(RadianceUi.muted)
        minHeight = dp(56)
        isSaveEnabled = false
        inputType = InputType.TYPE_CLASS_TEXT or if (multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        setSingleLine(!multiline)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        inputs.add(this)
    }
    private fun label(text: CharSequence, bold: Boolean = false) =
        RadianceUi.text(context, "", if (bold) 18 else 16, heading = bold).apply {
            this.text = text
            setTextIsSelectable(true)
        }
    private fun spans(items: JSONArray?): CharSequence = SpannableStringBuilder().apply {
        if (items != null) for (i in 0 until items.length()) {
            val span = items.getJSONObject(i); val start = length
            append(span.getString("text"))
            val style = when (span.optString("style")) {
                "strong" -> StyleSpan(Typeface.BOLD)
                "em" -> StyleSpan(Typeface.ITALIC)
                "code" -> TypefaceSpan("monospace")
                else -> null
            }
            if (style != null) setSpan(style, start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }
    private fun normalized(text: CharSequence) = whitespace.replace(text.toString().trim(), " ")
    private companion object { val whitespace = Regex("[\\s\\u00a0]+") }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
}
