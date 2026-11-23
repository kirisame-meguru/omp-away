package ru.eleven.ompaway

internal data class Pending(val id: String, val project: String, val question: String, val createdAt: Long, val session: String? = null)
internal fun validId(value: String) = value.length in 1..256 && value.all { it.code in 33..126 }
internal enum class Arrival { IGNORE, CACHE, NOTIFY }
internal fun freshInvite(sent: Long, ttl: Int, now: Long) = sent > 0 && ttl >= 0 && (ttl == 0 || now - sent < ttl * 1000L)

internal class InboxState {
    val pending = linkedMapOf<String, Pending>()
    val invited = linkedSetOf<String>()
    val silenced = linkedSetOf<String>()
    val closed = linkedSetOf<String>()
    val alerted = linkedSetOf<String>()
    val acknowledged = linkedSetOf<String>()
    val details = mutableMapOf<String, QuestionDisplay>()
    val proposals = mutableMapOf<String, String>()

    fun invalidateDetails() { details.clear(); proposals.clear() }
    fun question(id: String, display: QuestionDisplay?): Boolean {
        if (id !in pending || id in closed) return false
        if (display == null) details.remove(id) else details[id] = display
        return true
    }
    fun proposal(id: String, text: String): Boolean {
        if (id !in pending || id in closed) return false
        if (text.isEmpty()) proposals.remove(id) else proposals[id] = text
        return true
    }
    fun consumeAlert(id: String): Boolean {
        if (id !in pending || id !in invited || id in closed) return false
        val first = alerted.add(id)
        return first && id !in silenced && id !in acknowledged
    }

    fun invite(id: String, notificationAllowed: Boolean): Arrival {
        if (!validId(id) || id in silenced || id in closed || !invited.add(id)) return Arrival.IGNORE
        return if (notificationAllowed) Arrival.NOTIFY else Arrival.CACHE
    }

    fun silence(id: String) {
        if (id in invited || id in pending) silenced.add(id)
    }

    fun reconcile(items: List<Pending>): Set<String> {
        val gone = (pending.keys + invited + silenced).toMutableSet()
        gone.removeAll(closed)
        invalidateDetails()
        pending.clear()
        for (item in items) {
            pending[item.id] = item
            gone.remove(item.id)
            closed.remove(item.id)
        }
        silenced.removeAll(gone)
        closed.addAll(gone)
        return gone
    }
}

internal fun canJoin(state: InboxState, id: String, synchronized: Boolean, idle: Boolean, microphone: Boolean) =
    synchronized && idle && microphone && id in state.pending

/** An asynchronous getToken() result must not overwrite a newer onNewToken callback. */
internal class TokenUpdates {
    private var generation = 0L
    fun beginLookup() = ++generation
    fun rotated() { generation++ }
    fun isCurrent(lookup: Long) = generation == lookup
}
