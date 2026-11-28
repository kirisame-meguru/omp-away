package ru.eleven.ompaway

import android.app.Notification
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class InviteActionTest {
    @Test fun notificationDismissalAndNotNowBothLeaveAuthenticatedItemPending() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val target = instrument.targetContext
        val name = "away-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(target) {
            override fun getSharedPreferences(ignored: String, mode: Int): SharedPreferences =
                target.getSharedPreferences(name, mode)
        }
        val store = InboxStore(isolated)
        val id = UUID.randomUUID().toString()
        val item = Pending(id, "Project name must stay private", "Private question", 42)
        try {
            store.reconcile(listOf(item))
            val note = Invites.notification(target, id)
            assertNotNull(note.deleteIntent)
            assertNotNull(note.contentIntent)
            assertEquals(listOf("Answer by voice", "Not now"), note.actions.map { it.title.toString() })
            assertNotEquals(note.contentIntent, note.actions[0].actionIntent)
            assertNotEquals(note.actions[0].actionIntent, Invites.notification(target, "$id-2").actions[0].actionIntent)
            assertEquals("Desktop request", note.extras.getString(Notification.EXTRA_TITLE))
            assertTrue(note.extras.getString(Notification.EXTRA_TEXT)!!.contains("sync"))
            assertEquals(Notification.VISIBILITY_PRIVATE, note.visibility)
            assertNotNull(note.publicVersion)
            Invites.cancel(target, id)
            assertFalse(id in store.state.silenced)
            store.silence(id)
            val reopened = InboxStore(isolated)
            assertEquals(item, reopened.state.pending[id])
            assertTrue(id in reopened.state.silenced)
        } finally {
            target.deleteSharedPreferences(name)
        }
    }

    @Test fun retirementSeenAndSilenceSurviveRestartWithoutReRinging() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "away-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(target) {
            override fun getSharedPreferences(ignored: String, mode: Int): SharedPreferences =
                target.getSharedPreferences(name, mode)
        }
        try {
            val first = InboxStore(isolated)
            first.invite("native", true); first.invite("async", true)
            first.reconcile(listOf(Pending("native", "Project", "Native?", 1), Pending("async", "Project", "Async?", 2)))
            assertTrue(first.consumeAlert("native"))
            first.silence("async")
            first.reconcile(listOf(Pending("async", "Project", "Async?", 2)))
            val restarted = InboxStore(isolated)
            assertEquals(Arrival.IGNORE, restarted.invite("native", true))
            assertEquals(Arrival.IGNORE, restarted.invite("async", true))
            assertTrue("native" in restarted.state.closed)
            assertTrue("native" in restarted.state.invited)
            assertTrue("async" in restarted.state.silenced)
            assertFalse(restarted.consumeAlert("native"))
            assertFalse(restarted.consumeAlert("async"))
            restarted.needsSync = false
            assertEquals(Arrival.IGNORE, restarted.wakeup("native", true))
            assertTrue(InboxStore(isolated).needsSync)
            assertTrue("native" in restarted.state.closed)
            assertEquals(listOf("async"), restarted.state.pending.keys.toList())
            restarted.needsSync = false
            restarted.wakeup("", true)
            assertFalse(restarted.needsSync)
            assertTrue(restarted.state.details.isEmpty())
        } finally { target.deleteSharedPreferences(name) }
    }

    @Test fun previewPolicyAndPresentationPersistWithoutExposingLockScreenContent() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "away-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(target) {
            override fun getSharedPreferences(ignored: String, mode: Int): SharedPreferences =
                target.getSharedPreferences(name, mode)
        }
        try {
            val settings = InviteSettings(isolated)
            assertFalse(settings.showPreview)
            settings.showPreview = true
            assertTrue(InviteSettings(isolated).showPreview)
            val item = Pending("request", "Project", "Private question", 1, "Private session")
            val note = Invites.notification(isolated, item.id, item, ring = true)
            assertEquals("Private session", note.extras.getString(Notification.EXTRA_TITLE))
            assertEquals("Private question", note.extras.getString(Notification.EXTRA_TEXT))
            assertEquals("Desktop request", note.publicVersion.extras.getString(Notification.EXTRA_TITLE))
            assertFalse(note.publicVersion.extras.toString().contains("Private"))
            assertEquals(Notification.CATEGORY_CALL, note.category)
            assertEquals(2, note.actions.size)
            assertTrue(note.flags and Notification.FLAG_INSISTENT != 0)
            if (Build.VERSION.SDK_INT >= 31)
                assertEquals(Notification.CallStyle::class.java.name, note.extras.getString(Notification.EXTRA_TEMPLATE))
            else assertEquals(listOf("Answer call", "Not now"), note.actions.map { it.title.toString() })
            if (Build.VERSION.SDK_INT >= 34 &&
                !target.getSystemService(android.app.NotificationManager::class.java).canUseFullScreenIntent())
                assertNull(note.fullScreenIntent)
            val fallback = Invites.notification(isolated, item.id, item, ring = false)
            assertEquals(0, fallback.flags and Notification.FLAG_INSISTENT)
            settings.showPreview = false
            assertEquals("Desktop request", Invites.notification(isolated, item.id, item).extras.getString(Notification.EXTRA_TITLE))
        } finally { target.deleteSharedPreferences(name) }
    }

    @Test fun switchingSettingsBeforeOfflineSyncCannotRingOldRequestsAndAnswerAcknowledgementPersists() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "away-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(target) {
            override fun getSharedPreferences(ignored: String, mode: Int): SharedPreferences =
                target.getSharedPreferences(name, mode)
        }
        try {
            val store = InboxStore(isolated)
            store.wakeup("first", true)
            store.suppressExistingAlerts()
            store.reconcile(listOf(Pending("first", "Project", "Still pending", 1)))
            assertFalse(store.consumeAlert("first"))
            store.acknowledge("first")
            assertTrue("first" in InboxStore(isolated).state.acknowledged)
            assertEquals("Still pending", InboxStore(isolated).state.pending["first"]!!.question)
        } finally { target.deleteSharedPreferences(name) }
    }

    @Test fun explicitCallClearsOldSilenceButCannotRingTheSameTokenAfterRestart() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "away-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(target) {
            override fun getSharedPreferences(ignored: String, mode: Int): SharedPreferences =
                target.getSharedPreferences(name, mode)
        }
        try {
            val store = InboxStore(isolated)
            val item = Pending("call-question", "Example", "Still pending", 1, call = "call-token")
            store.reconcile(listOf(item))
            store.silence(item.id); store.acknowledge(item.id)
            assertTrue(store.ring(item))
            assertFalse(item.id in store.state.silenced)
            assertFalse(item.id in store.state.acknowledged)
            assertTrue(item.id in store.state.invited)
            val reopened = InboxStore(isolated)
            assertFalse(reopened.ring(item))
            assertTrue(item.id in reopened.state.pending)
            assertTrue(reopened.ring(item.copy(call = "another-call-token")))
        } finally { target.deleteSharedPreferences(name) }
    }

    @Test fun localeRefreshDoesNotTurnAReceiptIntoAPermanentQuestion() {
        org.junit.Assume.assumeTrue(BuildConfig.ISOLATED_INTEGRATION)
        val instrument = InstrumentationRegistry.getInstrumentation()
        val context = instrument.targetContext
        org.junit.Assume.assumeTrue(Invites.allowed(context))
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        val id = "receipt-locale-test"
        try {
            instrument.runOnMainSync { Invites.receipt(context, id, "Answer submitted") }
            instrument.waitForIdleSync()
            instrument.runOnMainSync { Invites.refreshLanguage(context.applicationContext as Gateway) }
            val receipt = manager.activeNotifications.single { it.tag == id && it.id == 2 }.notification
            assertEquals(4_000L, receipt.timeoutAfter)
            assertEquals("Answer submitted", receipt.extras.getString(Notification.EXTRA_TITLE))
        } finally { manager.cancel(id, 2) }
    }

    @Test fun notificationPermissionDenialCannotBeBypassedByACall() {
        if (Build.VERSION.SDK_INT < 33) return
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val denied = object : ContextWrapper(target) {
            override fun checkSelfPermission(permission: String) = android.content.pm.PackageManager.PERMISSION_DENIED
        }
        assertFalse(Invites.allowed(denied, Invites.CHANNEL))
        assertFalse(Invites.allowed(denied, Invites.CALL_CHANNEL))
    }
}
