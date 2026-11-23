package ru.eleven.ompaway

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import ru.eleven.ompaway.security.bytesJson
import ru.eleven.ompaway.security.decodeInboxSnapshot

/** Run only on a disposable, unpaired emulator, with notification and microphone permissions granted.
 * These are real OS notifications/PendingIntents/foreground services. Snapshots enter the same
 * post-authentication handler as PairedChannel; this does not replace the separate pinned-relay test.
 */
class InvitationLifecycleTest {
    @Test fun actualActionsRetireNativeAndAsyncRequestsWithoutJoiningAStaleRequest() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("disposableLifecycle") == "true")
        val context = instrument.targetContext
        val app = context.applicationContext as Gateway
        var unpaired = false
        instrument.runOnMainSync { unpaired = !app.paired && app.store.state.pending.isEmpty() && app.store.state.invited.isEmpty() }
        assumeTrue("Never alter an existing pairing or inbox", unpaired)
        assumeTrue(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        assumeTrue(Invites.allowed(context, Invites.CHANNEL))
        val manager = context.getSystemService(NotificationManager::class.java)
        val oldCallMode = app.inviteSettings.callMode
        val oldPreview = app.inviteSettings.showPreview
        val native = "test-native-request"
        val async = "test-async-request"
        val declined = "test-declined-request"
        var activity: Activity? = null
        var covering: Activity? = null
        fun snapshot(vararg ids: String) {
            val rows = JSONArray()
            for (id in ids) rows.put(JSONObject().put("requestId", id).put("project", "Example project")
                .put("session", if (id == native) "Native session" else "Async session")
                .put("question", if (id == native) "Choose the native option?" else "Choose the async option?").put("createdAt", 1200L))
            val decoded = decodeInboxSnapshot(bytesJson(JSONObject().put("type", "inbox").put("items", rows).toString().toByteArray()))
            instrument.runOnMainSync { app.reconcileInbox(decoded) }
        }
        fun notes() = manager.activeNotifications.filter { it.id == 1 }.associateBy { it.tag }
        fun await(message: String, condition: () -> Boolean) {
            val until = SystemClock.elapsedRealtime() + 5000
            while (SystemClock.elapsedRealtime() < until) {
                instrument.waitForIdleSync()
                if (condition()) return
                SystemClock.sleep(25)
            }
            assertTrue(message, condition())
        }
        try {
            instrument.runOnMainSync { app.inviteSettings.callMode = false; app.inviteSettings.showPreview = true }
            activity = instrument.startActivitySync(Intent(context, InboxActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            instrument.runOnMainSync {
                app.receivedInvite(native, true); app.receivedInvite(async, true)
                assertNull(app.callId)
                assertTrue(notes()[native]!!.notification.extras.getString(android.app.Notification.EXTRA_TEXT)!!.contains("sync"))
            }
            snapshot(native, async)
            await("Authenticated previews were not published") { notes().keys.containsAll(listOf(native, async)) }
            assertEquals("Native session", notes()[native]!!.notification.extras.getString(android.app.Notification.EXTRA_TITLE))
            assertEquals("Choose the native option?", notes()[native]!!.notification.extras.getString(android.app.Notification.EXTRA_TEXT))
            val staleAnswer = notes()[native]!!.notification.actions.first().actionIntent
            val asyncAnswer = notes()[async]!!.notification.actions.first().actionIntent
            instrument.runOnMainSync {
                app.inviteSettings.callMode = true; app.invitationSettingsChanged()
            }
            assertTrue(notes().values.none { it.notification.flags and android.app.Notification.FLAG_INSISTENT != 0 })
            assumeTrue(Invites.allowed(context, Invites.CALL_CHANNEL))
            instrument.runOnMainSync { app.receivedInvite(declined, true) }
            snapshot(native, async, declined)
            await("New call invitation never entered ringing presentation") {
                notes()[declined]?.notification?.flags?.and(android.app.Notification.FLAG_INSISTENT) == android.app.Notification.FLAG_INSISTENT
            }
            val incoming = notes()[declined]!!.notification
            assertTrue(incoming.flags and android.app.Notification.FLAG_INSISTENT != 0)
            val declineAction = incoming.actions.single { it.actionIntent == incoming.deleteIntent }
            declineAction.actionIntent.send()
            await("Decline did not cancel its own notification") { declined !in notes() }
            instrument.runOnMainSync {
                assertTrue(declined in app.store.state.pending)
                assertTrue(declined in app.store.state.silenced)
                assertNull(app.callId)
            }
            assertTrue(native in notes() && async in notes())
            snapshot(async, declined)
            await("Native withdrawal left a notification") { native !in notes() && async in notes() }
            staleAnswer.send()
            await("Answer did not request fresh reconciliation") { app.status.contains("Checking") }
            snapshot(async, declined)
            instrument.runOnMainSync {
                assertNull(app.callId)
                assertTrue(app.status.contains("no longer pending"))
                assertTrue(async in app.store.state.pending)
                assertTrue(native in InboxStore(context).state.closed)
            }
            assertTrue(async in notes())
            // A valid current Answer creates the real microphone FGS while waiting for voice.
            // No joined frame is synthesized, so this test never invents audio or a submitted Ask.
            asyncAnswer.send()
            await("Current Answer did not request a fresh snapshot") { app.status.contains("Checking") }
            snapshot(async, declined)
            await("Explicit Answer did not enter foreground-call state") {
                app.callId == async && manager.activeNotifications.any { it.id == 4092 }
            }
            covering = instrument.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            instrument.runOnMainSync { assertEquals(async, app.callId) }
            snapshot(declined)
            await("Async withdrawal did not stop the matching foreground call") {
                app.callId == null && manager.activeNotifications.none { it.id == 4092 || it.tag == async }
            }
            instrument.runOnMainSync {
                app.receivedInvite(native, true); app.receivedInvite(async, true)
                assertTrue(app.store.needsSync)
                assertTrue(native in app.store.state.closed && async in app.store.state.closed)
                assertNull(app.callId)
            }
            assertFalse(native in notes() || async in notes())
            snapshot(declined)
            assertFalse(native in notes() || async in notes())
        } finally {
            instrument.runOnMainSync {
                app.hangup(); covering?.finish(); activity?.finish()
                app.inviteSettings.callMode = oldCallMode; app.inviteSettings.showPreview = oldPreview
                // Test-owned IDs only; never clear a real pairing or shared device storage.
                for (id in listOf(native, async, declined)) {
                    Invites.cancel(context, id)
                    app.store.state.pending.remove(id); app.store.state.invited.remove(id)
                    app.store.state.silenced.remove(id); app.store.state.closed.remove(id)
                    app.store.state.alerted.remove(id); app.store.state.acknowledged.remove(id)
                }
                app.store.reconcile(app.store.state.pending.values.toList())
                app.store.needsSync = false
            }
        }
    }
}
