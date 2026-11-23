package ru.eleven.ompaway

import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Activity, receiver and notification-service callbacks serialize mutations on the main looper. */
internal class InboxStore(context: Context) {
    private val prefs = context.getSharedPreferences("private-inbox", Context.MODE_PRIVATE)
    val state = InboxState()
    var needsSync: Boolean
        get() = prefs.getBoolean("needs-sync", false)
        set(value) { prefs.edit().putBoolean("needs-sync", value).commit() }

    init {
        try {
            val doc = JSONObject(prefs.getString("snapshot", "{}") ?: "{}")
            val rows = doc.optJSONArray("pending") ?: JSONArray()
            repeat(rows.length()) { i ->
                val row = rows.getJSONArray(i)
                val item = Pending(row.getString(0), row.getString(1), row.getString(2), row.getLong(3),
                    if (row.length() > 4) row.getString(4).takeIf { it.isNotEmpty() } else null)
                state.pending[item.id] = item
            }
            for ((name, set) in listOf("invited" to state.invited, "silenced" to state.silenced,
                "closed" to state.closed, "alerted" to state.alerted, "acknowledged" to state.acknowledged)) {
                val array = doc.optJSONArray(name) ?: continue
                repeat(array.length()) { i -> set.add(array.getString(i)) }
            }
        } catch (_: JSONException) {
            state.pending.clear(); state.invited.clear(); state.silenced.clear(); state.closed.clear(); state.alerted.clear(); state.acknowledged.clear()
            prefs.edit().remove("snapshot").apply()
        }
    }

    fun invite(id: String, allowed: Boolean) = state.invite(id, allowed).also { if (it != Arrival.IGNORE) save() }
    fun wakeup(id: String, allowed: Boolean): Arrival {
        if (!validId(id)) return Arrival.IGNORE
        needsSync = true
        return invite(id, allowed)
    }
    fun silence(id: String) { state.silence(id); save() }
    fun reconcile(items: List<Pending>) = state.reconcile(items).also { save() }
    fun consumeAlert(id: String): Boolean {
        val already = id in state.alerted
        val alert = state.consumeAlert(id)
        if (!already && id in state.alerted) save()
        return alert
    }
    fun suppressExistingAlerts() { if (state.alerted.addAll(state.invited)) save() }
    fun acknowledge(id: String) {
        if (!validId(id) || (id !in state.invited && id !in state.pending)) return
        state.acknowledged.add(id); state.alerted.add(id); save()
    }

    private fun save() {
        val rows = JSONArray()
        for (item in state.pending.values) rows.put(JSONArray().put(item.id).put(item.project).put(item.question).put(item.createdAt).put(item.session.orEmpty()))
        val snapshot = JSONObject().put("pending", rows).put("invited", JSONArray(state.invited))
            .put("closed", JSONArray(state.closed)).put("silenced", JSONArray(state.silenced)).put("alerted", JSONArray(state.alerted))
            .put("acknowledged", JSONArray(state.acknowledged))
        // Push callbacks must not return before replay/retirement suppression is durable.
        prefs.edit().putString("snapshot", snapshot.toString()).commit()
    }
}
