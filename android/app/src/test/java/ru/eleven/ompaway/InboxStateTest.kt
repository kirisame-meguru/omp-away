package ru.eleven.ompaway

import org.junit.Assert.*
import org.junit.Test
import ru.eleven.ompaway.security.DetailsNegotiation

class InboxStateTest {
    private val item = Pending("id-1", "Project", "Choose?", 1200L)

    @Test fun oldPeerDowngradeIsAuthenticatedAndOnlyAttemptedOnce() {
        val capability = DetailsNegotiation()
        assertFalse(capability.retryLegacy(authenticated = false))
        assertTrue(capability.enabled)
        assertTrue(capability.retryLegacy(authenticated = true))
        assertFalse(capability.enabled)
        assertFalse(capability.retryLegacy(authenticated = true))
        val supported = DetailsNegotiation()
        supported.receivedDetails()
        assertFalse(supported.retryLegacy(authenticated = true))
        assertTrue(supported.enabled)
    }

    @Test fun snapshotsAndDisconnectDiscardDetailsButNeverAssociateOrphans() {
        val state = InboxState()
        val display = QuestionDisplay(1, "Context", listOf(
            DisplayField("f0", "Choose", "single", true, options = listOf(
                DisplayOption("o0", "Same", false), DisplayOption("o1", "Same", true)
            ))
        ))
        assertFalse(state.question(item.id, display))
        state.reconcile(listOf(item))
        assertTrue(state.question(item.id, display))
        assertEquals(listOf("o0", "o1"), state.details[item.id]!!.fields.single().options.map { it.id })
        assertTrue(state.proposal(item.id, "Same"))
        state.reconcile(listOf(item))
        assertTrue(state.details.isEmpty())
        assertTrue(state.proposals.isEmpty())
        state.question(item.id, display)
        state.invalidateDetails()
        assertTrue(state.details.isEmpty())
        state.reconcile(emptyList())
        assertFalse(state.question(item.id, display))
        assertFalse(state.proposal(item.id, "Same"))
    }

    @Test fun onlyFreshFirstReconciliationMayAlertAndRetirementRetainsSeenIdentity() {
        val state = InboxState()
        state.invite(item.id, true)
        assertFalse(state.consumeAlert(item.id))
        state.reconcile(listOf(item))
        assertTrue(state.consumeAlert(item.id))
        assertFalse(state.consumeAlert(item.id))
        state.reconcile(emptyList())
        assertTrue(item.id in state.invited)
        assertTrue(item.id in state.closed)
        assertEquals(Arrival.IGNORE, state.invite(item.id, true))
        assertFalse(state.consumeAlert(item.id))
    }

    @Test fun withdrawalOnlyRetiresTheMatchingRequestAndSilenceNeverAuthorizesSubmission() {
        val state = InboxState()
        val other = item.copy(id = "id-2")
        state.invite(item.id, true); state.invite(other.id, true)
        state.reconcile(listOf(item, other))
        state.silence(other.id)
        assertEquals(setOf(item.id), state.reconcile(listOf(other)))
        assertEquals(other, state.pending[other.id])
        assertFalse(state.consumeAlert(other.id))
        assertFalse(canJoin(state, item.id, true, true, true))
    }

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
