package ru.eleven.ompaway

internal data class Pending(val id: String, val project: String, val question: String, val createdAt: Long)
internal fun validId(value: String) = value.length in 1..256 && value.all { it.code in 33..126 }
internal enum class Arrival { IGNORE, CACHE, NOTIFY }
internal fun freshInvite(sent: Long, ttl: Int, now: Long) = sent > 0 && ttl >= 0 && (ttl == 0 || now - sent < ttl * 1000L)

internal class InboxState {
    val pending = linkedMapOf<String, Pending>()
    val invited = linkedSetOf<String>()
    val silenced = linkedSetOf<String>()
    val closed = linkedSetOf<String>()

    fun invite(id: String, notificationAllowed: Boolean): Arrival {
        if (!validId(id) || id in silenced || id in closed || !invited.add(id)) return Arrival.IGNORE
        if (invited.size > 1024) invited.remove(invited.first())
        return if (notificationAllowed) Arrival.NOTIFY else Arrival.CACHE
    }

    fun silence(id: String) {
        if (id in invited || id in pending) silenced.add(id)
    }

    fun reconcile(items: List<Pending>): Set<String> {
        val gone = (pending.keys + invited + silenced).toMutableSet()
        pending.clear()
        for (item in items) {
            pending[item.id] = item
            gone.remove(item.id)
            closed.remove(item.id)
        }
        invited.removeAll(gone)
        silenced.removeAll(gone)
        closed.addAll(gone)
        while (closed.size > 1024) closed.remove(closed.first())
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
