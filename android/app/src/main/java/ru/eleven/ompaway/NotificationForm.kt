package ru.eleven.ompaway

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

/**
 * Answers a question from the notification shade with native RemoteViews and RemoteInput.
 * The handset keeps only a draft; the desktop still validates and owns every submission.
 */
internal object NotificationForm {
    private const val ACTION = "ru.eleven.ompaway.NOTIFICATION_FORM"
    private const val INPUT = "input"
    private const val OPTIONS_PER_PAGE = 2 // SystemUI caps expanded custom content height.

    /** Shade-only state; drafts themselves are shared with the in-app form. */
    class State {
        var page = 0
        var message: String? = null
        /** Fields whose Other choice is selected but whose text has not been entered yet. */
        val otherPending = mutableSetOf<String>()
        /** Option value that receives the next note, per field. */
        val focus = mutableMapOf<String, String>()
    }

    private class Option(val value: String, val label: String, val disabled: Boolean)
    private class Field(val json: JSONObject) {
        val name: String = json.getString("name")
        val text = json.getString("kind") == "text"
        val multi = json.optBoolean("multi")
        val array = json.optBoolean("array")
        val required = json.optBoolean("required")
        val other = json.optBoolean("other")
        val caption: String = json.optString("question", name)
        val options = json.optJSONArray("options")?.let { list ->
            List(list.length()) { i ->
                val option = list.getJSONObject(i)
                val value = option.getString("value")
                Option(value, spans(option.optJSONArray("label")).ifEmpty { value }, option.optBoolean("disabled"))
            }
        }.orEmpty()
        /** Rows include a trailing Other row when the field allows it. */
        val rows get() = options.size + if (other) 1 else 0
    }
    private class Page(val field: Int, val start: Int)

    private fun spans(items: JSONArray?) = buildString {
        if (items != null) for (i in 0 until items.length()) append(items.getJSONObject(i).optString("text"))
    }

    private fun fields(schema: JSONObject): List<Field> = buildList {
        val sections = schema.getJSONArray("sections")
        for (i in 0 until sections.length()) {
            val blocks = sections.getJSONObject(i).getJSONArray("blocks")
            for (j in 0 until blocks.length()) {
                val block = blocks.getJSONObject(j)
                if (block.getString("kind") == "field") add(Field(block.getJSONObject("field")))
            }
        }
    }

    private fun pages(fields: List<Field>): List<Page> = buildList {
        for ((index, field) in fields.withIndex()) {
            if (field.text || field.rows == 0) add(Page(index, 0))
            else for (start in 0 until field.rows step OPTIONS_PER_PAGE) add(Page(index, start))
        }
    }

    /** Authored title and prose: what the in-app form shows above its fields. */
    private fun heading(schema: JSONObject): Pair<String, String> {
        val prose = mutableListOf<String>()
        var title = schema.optString("title")
        schema.optString("description").takeIf { it.isNotBlank() }?.let(prose::add)
        val sections = schema.getJSONArray("sections")
        for (i in 0 until sections.length()) {
            val section = sections.getJSONObject(i)
            val caption = spans(section.optJSONArray("title"))
            if (title.isBlank() && caption.isNotBlank()) title = caption
            val blocks = section.getJSONArray("blocks")
            for (j in 0 until blocks.length()) {
                val block = blocks.getJSONObject(j)
                when (block.getString("kind")) {
                    "text" -> spans(block.optJSONArray("spans")).takeIf { it.isNotBlank() && it != title }?.let(prose::add)
                    "list" -> block.optJSONArray("items")?.let { items ->
                        for (k in 0 until items.length()) prose.add("• " + spans(items.getJSONArray(k)))
                    }
                }
            }
        }
        return title to prose.distinct().joinToString("\n")
    }

    private fun selected(draft: JSONObject, name: String): MutableList<String> = when (val raw = draft.opt(name)) {
        is JSONArray -> MutableList(raw.length()) { raw.getString(it) }
        null, JSONObject.NULL -> mutableListOf()
        else -> mutableListOf(raw.toString())
    }

    private fun store(draft: JSONObject, field: Field, values: List<String>) {
        if (field.array) draft.put(field.name, JSONArray(values))
        else if (values.isEmpty()) draft.remove(field.name)
        else draft.put(field.name, values.first())
    }

    private fun custom(field: Field, values: List<String>) = values.firstOrNull { value -> field.options.none { it.value == value } }

    /** Same defaults as the in-app form: checked options and authored text values. */
    private fun draft(app: Gateway, id: String, fields: List<Field>): JSONObject = app.drafts.getOrPut(id) {
        JSONObject().also { draft ->
            for (field in fields) {
                if (field.text) draft.put(field.name, field.json.optString("value"))
                else {
                    val list = field.json.getJSONArray("options")
                    store(draft, field, (0 until list.length()).map(list::getJSONObject)
                        .filter { it.optBoolean("checked") && !it.optBoolean("disabled") }.map { it.getString("value") })
                }
            }
        }
    }

    private fun note(notes: JSONArray?, name: String, value: String): String? {
        if (notes != null) for (i in 0 until notes.length()) {
            val note = notes.getJSONObject(i)
            if (note.optString("name") == name && note.optString("value") == value) return note.optString("text")
        }
        return null
    }

    private fun broadcast(context: Context, id: String, op: String, field: Int = 0, option: Int = 0, input: Boolean = false): PendingIntent {
        val uri = Uri.Builder().scheme("omp-away").authority("form").appendPath(id).appendPath(op)
            .appendPath(field.toString()).appendPath(option.toString()).build()
        val intent = Intent(context, NotificationFormReceiver::class.java).setAction(ACTION).setData(uri)
        // RemoteInput must fill in the reply, so only those explicit, receiver-bound intents are mutable.
        val mutability = if (input) { if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0 } else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutability)
    }

    private fun inputAction(context: Context, id: String, op: String, field: Int, title: String, hint: String, option: Int = 0) =
        Notification.Action.Builder(null, title, broadcast(context, id, op, field, option, input = true))
            .addRemoteInput(RemoteInput.Builder(INPUT).setLabel(hint).build()).build()

    /** Returns false when the schema cannot be rendered; callers then keep the generic actions. */
    fun decorate(context: Context, builder: Notification.Builder, app: Gateway, id: String, schema: JSONObject, negative: PendingIntent): Boolean {
        val fields = try { fields(schema) } catch (_: org.json.JSONException) { return false }
        val pages = pages(fields)
        if (pages.isEmpty()) return false
        val state = app.notificationStates.getOrPut(id) { State() }
        state.page = state.page.coerceIn(0, pages.size - 1)
        val page = pages[state.page]
        val field = fields[page.field]
        val draft = draft(app, id, fields)
        val notes = app.noteDrafts[id]
        val optionNotes = schema.optBoolean("optionNotes")
        val submitting = id in app.submitting
        val view = RemoteViews(context.packageName, R.layout.notification_form)
        val (title, body) = heading(schema)
        fun text(viewId: Int, value: CharSequence?) {
            view.setTextViewText(viewId, value ?: "")
            view.setViewVisibility(viewId, if (value.isNullOrBlank()) View.GONE else View.VISIBLE)
        }
        text(R.id.form_title, title)
        text(R.id.form_body, body)
        text(R.id.form_caption, field.caption + if (field.required) " *" else "")
        var value: String? = null
        var input: Notification.Action? = null
        if (field.text) {
            val current = draft.optString(field.name)
            value = current.ifBlank { context.uiString(R.string.notification_type_hint) }
            input = inputAction(context, id, "text", page.field, context.uiString(R.string.your_answer), field.caption)
        } else {
            val values = selected(draft, field.name)
            val customValue = custom(field, values)
            val otherSelected = customValue != null || field.name in state.otherPending
            for (row in page.start until minOf(field.rows, page.start + OPTIONS_PER_PAGE)) {
                val option = field.options.getOrNull(row)
                val checked = if (option != null) option.value in values else otherSelected
                val mark = if (field.multi) (if (checked) "☑" else "☐") else (if (checked) "◉" else "○")
                val label = option?.label ?: (context.uiString(R.string.other) + (customValue?.let { ": $it" } ?: ""))
                val noted = note(notes, field.name, option?.value ?: customValue.orEmpty())?.takeIf { checked && it.isNotBlank() }
                val line = RemoteViews(context.packageName, R.layout.notification_option)
                line.setTextViewText(R.id.form_option, "$mark  $label" + (noted?.let { "\n    ✎ $it" } ?: ""))
                if (option?.disabled == true || submitting) line.setBoolean(R.id.form_option, "setEnabled", false)
                else line.setOnClickPendingIntent(R.id.form_option, broadcast(context, id, "select", page.field, row))
                view.addView(R.id.form_options, line)
            }
            val focus = state.focus[field.name]?.takeIf { it in values }
            if (otherSelected && customValue == null)
                input = inputAction(context, id, "other", page.field, context.uiString(R.string.notification_other_answer),
                    context.uiString(R.string.your_answer))
            else if (optionNotes && focus != null) {
                val focusLabel = field.options.firstOrNull { it.value == focus }?.label ?: focus
                input = inputAction(context, id, "note", page.field,
                    context.uiString(if (note(notes, field.name, focus).isNullOrBlank()) R.string.notification_add_note else R.string.notification_edit_note),
                    context.uiString(R.string.notes_for, focusLabel), field.options.indexOfFirst { it.value == focus }.let { if (it < 0) field.options.size else it })
            }
        }
        text(R.id.form_value, value)
        text(R.id.form_message, state.message ?: app.formMessage(id))
        if (pages.size > 1) {
            view.setViewVisibility(R.id.form_page, View.VISIBLE)
            view.setTextViewText(R.id.form_page, "${state.page + 1}/${pages.size}")
            fun nav(viewId: Int, label: Int, step: Int, enabled: Boolean) {
                view.setTextViewText(viewId, context.uiString(label))
                view.setViewVisibility(viewId, if (enabled) View.VISIBLE else View.INVISIBLE)
                if (enabled) view.setOnClickPendingIntent(viewId, broadcast(context, id, "page", option = step))
            }
            nav(R.id.form_previous, R.string.notification_previous, 0, state.page > 0)
            nav(R.id.form_next, R.string.notification_next, 1, state.page < pages.size - 1)
        } else for (viewId in intArrayOf(R.id.form_previous, R.id.form_page, R.id.form_next)) view.setViewVisibility(viewId, View.GONE)
        if (schema.optBoolean("voice", true) && app.idle && !submitting) {
            view.setTextViewText(R.id.form_voice, context.uiString(R.string.answer_by_voice))
            view.setOnClickPendingIntent(R.id.form_voice, Invites.intent(context, id, Invites.ANSWER, true))
        } else view.setViewVisibility(R.id.form_voice, View.GONE)
        builder.setStyle(Notification.DecoratedCustomViewStyle()).setCustomBigContentView(view)
        if (!submitting) {
            input?.let(builder::addAction)
            builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.notification_submit),
                broadcast(context, id, "submit")).build())
        }
        builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.not_now), negative).build())
        return true
    }

    /** Main-thread handler for every notification control. */
    fun handle(app: Gateway, intent: Intent) {
        val path = intent.data?.pathSegments ?: return
        if (intent.action != ACTION || path.size != 4) return
        val id = path[0].takeIf(::validId) ?: return
        val op = path[1]
        val fieldIndex = path[2].toIntOrNull() ?: return
        val row = path[3].toIntOrNull() ?: return
        val schema = app.notificationForm(id)
        if (schema == null) {
            // The process may have been reclaimed while SystemUI kept the card. Refetch
            // its authenticated schema, never reinterpret a stale selection or resend a reply.
            if (id in app.store.state.pending) {
                app.store.needsSync = true
                SilenceJob.schedule(app)
                Invites.receipt(app, id, app.uiString(R.string.reconnect_to_answer))
            }
            app.refreshNotification(id)
            return
        }
        if (id in app.submitting) { app.refreshNotification(id); return }
        val fields = try { fields(schema) } catch (_: org.json.JSONException) { return }
        val pages = pages(fields)
        val field = fields.getOrNull(fieldIndex) ?: return
        val state = app.notificationStates.getOrPut(id) { State() }
        val draft = draft(app, id, fields)
        val reply = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(INPUT)?.toString()
        state.message = null
        when (op) {
            "page" -> state.page = (state.page + if (row == 1) 1 else -1).coerceIn(0, pages.size - 1)
            "select" -> if (!field.text && row in 0 until field.rows) {
                val values = selected(draft, field.name)
                val customValue = custom(field, values)
                val option = field.options.getOrNull(row)
                if (option == null) {
                    val wasSelected = customValue != null || field.name in state.otherPending
                    if (customValue != null) values.remove(customValue)
                    if (wasSelected) state.otherPending.remove(field.name)
                    else {
                        if (!field.multi) values.clear()
                        state.otherPending.add(field.name)
                    }
                } else if (!option.disabled) {
                    if (field.multi) { if (!values.remove(option.value)) values.add(option.value) }
                    else { values.clear(); values.add(option.value); state.otherPending.remove(field.name) }
                    if (option.value in values) state.focus[field.name] = option.value
                }
                store(draft, field, values)
            }
            "text" -> if (field.text && reply != null) draft.put(field.name, reply)
            "other" -> reply?.trim()?.takeIf { it.isNotEmpty() && !field.text && field.name in state.otherPending }?.let { text ->
                val values = selected(draft, field.name)
                custom(field, values)?.let(values::remove)
                if (!field.multi) values.clear()
                values.add(text)
                state.otherPending.remove(field.name)
                state.focus[field.name] = text
                store(draft, field, values)
            }
            "note" -> {
                val focus = field.options.getOrNull(row)?.value
                    ?: if (row == field.options.size) custom(field, selected(draft, field.name)) else null
                if (reply != null && focus != null && focus in selected(draft, field.name)) {
                    val prior = app.noteDrafts[id] ?: JSONArray()
                    val next = JSONArray()
                    for (i in 0 until prior.length()) {
                        val note = prior.getJSONObject(i)
                        if (note.optString("name") != field.name || note.optString("value") != focus) next.put(note)
                    }
                    if (reply.isNotBlank()) next.put(JSONObject().put("name", field.name).put("value", focus).put("text", reply))
                    app.noteDrafts[id] = next
                }
            }
            "submit" -> {
                val error = fields.withIndex().firstNotNullOfOrNull { (index, item) ->
                    val values = if (item.text) null else selected(draft, item.name)
                    val message = when {
                        item.text -> if (item.required && draft.optString(item.name).isBlank()) "${item.caption}: ${app.uiString(R.string.enter_an_answer)}" else null
                        item.name in state.otherPending -> app.uiString(R.string.enter_other_answer, item.caption)
                        item.required && values!!.isEmpty() -> app.uiString(R.string.select_answer, item.caption)
                        else -> null
                    }
                    message?.let { index to it }
                }
                if (error != null) {
                    state.page = pages.indexOfFirst { it.field == error.first }.coerceAtLeast(0)
                    state.message = error.second
                } else {
                    val notes = JSONArray()
                    if (schema.optBoolean("optionNotes")) app.noteDrafts[id]?.let { prior ->
                        for (i in 0 until prior.length()) {
                            val note = prior.getJSONObject(i)
                            val owner = fields.firstOrNull { it.name == note.optString("name") } ?: continue
                            if (note.optString("value") in selected(draft, owner.name)) notes.put(note)
                        }
                    }
                    app.externalDrafts.add(id)
                    app.answerFromNotification(id, JSONObject(draft.toString()), notes)
                    return
                }
            }
            else -> return
        }
        app.notificationDraftChanged(id)
    }

}

class NotificationFormReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        NotificationForm.handle(context.applicationContext as Gateway, intent)
    }
}
