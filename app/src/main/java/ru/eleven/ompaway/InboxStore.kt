package ru.eleven.ompaway

import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Activity, receiver and notification-service callbacks serialize mutations on the main looper. */
internal class InboxStore(context: Context) {
    private val prefs = context.getSharedPreferences("private-inbox", Context.MODE_PRIVATE)
    val state = InboxState()

    init {
        try {
            val doc = JSONObject(prefs.getString("snapshot", "{}") ?: "{}")
            val rows = doc.optJSONArray("pending") ?: JSONArray()
            repeat(rows.length()) { i ->
                val row = rows.getJSONArray(i)
                val item = Pending(row.getString(0), row.getString(1), row.getString(2), row.getLong(3))
                state.pending[item.id] = item
            }
            for ((name, set) in listOf("invited" to state.invited, "silenced" to state.silenced, "closed" to state.closed)) {
                val array = doc.optJSONArray(name) ?: continue
                repeat(array.length()) { i -> set.add(array.getString(i)) }
            }
        } catch (_: JSONException) {
            state.pending.clear(); state.invited.clear(); state.silenced.clear(); state.closed.clear()
            prefs.edit().remove("snapshot").apply()
        }
    }

    fun invite(id: String, allowed: Boolean) = state.invite(id, allowed).also { if (it != Arrival.IGNORE) save() }
    fun silence(id: String) { state.silence(id); save() }
    fun reconcile(items: List<Pending>) = state.reconcile(items).also { save() }

    private fun save() {
        val rows = JSONArray()
        for (item in state.pending.values) rows.put(JSONArray().put(item.id).put(item.project).put(item.question).put(item.createdAt))
        val snapshot = JSONObject().put("pending", rows).put("invited", JSONArray(state.invited))
            .put("closed", JSONArray(state.closed)).put("silenced", JSONArray(state.silenced))
        prefs.edit().putString("snapshot", snapshot.toString()).apply()
    }
}
