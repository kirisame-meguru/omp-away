package ru.eleven.ompaway

import org.junit.Assert.*
import org.junit.Test

class InboxStateTest {
    private val item = Pending("id-1", "Project", "Choose?", 1200L)

    @Test fun inviteIsGenericDeduplicatedAndDoesNotGrantJoin() {
        val state = InboxState()
        assertEquals(Arrival.NOTIFY, state.invite(item.id, true))
        assertEquals(Arrival.IGNORE, state.invite(item.id, true))
        assertTrue(state.pending.isEmpty())
        assertFalse(canJoin(state, item.id, synchronized = false, idle = true, microphone = true))
    }

    @Test fun deniedNotificationsStillCreateAMissedInvite() {
        val state = InboxState()
        assertEquals(Arrival.CACHE, state.invite(item.id, false))
        assertTrue(item.id in state.invited)
        assertTrue(state.pending.isEmpty())
    }

    @Test fun delayedFcmDeliveryAtExpiryIsStale() {
        assertTrue(freshInvite(1000, 45, 45999))
        assertFalse(freshInvite(1000, 45, 46000))
    }

    @Test fun notNowSurvivesReconciliationWithoutClosingTheAsk() {
        val state = InboxState()
        state.invite(item.id, true)
        state.silence(item.id)
        state.reconcile(listOf(item))
        assertEquals(listOf(item), state.pending.values.toList())
        assertTrue(item.id in state.silenced)
        assertEquals(Arrival.IGNORE, state.invite(item.id, true))
        assertFalse(canJoin(state, item.id, synchronized = true, idle = true, microphone = false))
        assertFalse(canJoin(state, item.id, synchronized = true, idle = false, microphone = true))
        assertTrue(canJoin(state, item.id, synchronized = true, idle = true, microphone = true))
    }

    @Test fun desktopRemovalWinsEvenOverALatePush() {
        val state = InboxState()
        state.reconcile(listOf(item))
        state.reconcile(emptyList())
        assertEquals(Arrival.IGNORE, state.invite(item.id, true))
        assertFalse(canJoin(state, item.id, synchronized = true, idle = true, microphone = true))
        assertFalse(item.id in state.silenced)
    }

    @Test fun aLateFirebaseTokenLookupCannotUndoRotation() {
        val updates = TokenUpdates()
        val lookup = updates.beginLookup()
        updates.rotated()
        assertFalse(updates.isCurrent(lookup))
        assertTrue(updates.isCurrent(updates.beginLookup()))
    }

    @Test fun bufferedOrFutureAudioIsNotACompletedReadback() {
        assertFalse(presented(target = 1440, position = 960, presentationNs = 100, nowNs = 120))
        assertFalse(presented(target = 1440, position = 1440, presentationNs = 160, nowNs = 120))
        assertTrue(presented(target = 1440, position = 1920, presentationNs = 100, nowNs = 120))
    }
}
