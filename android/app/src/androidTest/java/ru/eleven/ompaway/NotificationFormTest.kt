package ru.eleven.ompaway

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import ru.eleven.ompaway.security.InboxItem

/** Real RemoteViews/PendingIntents/RemoteInput in an isolated, unpaired test package. */
class NotificationFormTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrument.targetContext
    private val app get() = context.applicationContext as Gateway
    private val id = "notification-form-test"
    private val schema = JSONObject("""{
        "title":"Shade question: favorite color","description":"Choose a color and explain why.","optionNotes":true,
        "sections":[{"blocks":[
            {"kind":"field","field":{"kind":"choice","name":"color","question":"Pick a color","required":true,"other":true,"options":[
                {"value":"red","label":[{"text":"Red"}]},
                {"value":"blue","label":[{"text":"Blue"}],"checked":true},
                {"value":"green","label":[{"text":"Green"}],"disabled":true}]}},
            {"kind":"field","field":{"kind":"choice","name":"extras","question":"Extras","multi":true,"array":true,"options":[
                {"value":"x","label":[{"text":"Extra X"}]},{"value":"y","label":[{"text":"Extra Y"}]}]}},
            {"kind":"field","field":{"kind":"text","name":"reason","question":"Reason","required":true}}
        ]}]
    }""")

    private fun await(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5000
        while (SystemClock.elapsedRealtime() < deadline) {
            instrument.waitForIdleSync()
            if (predicate()) return
            SystemClock.sleep(30)
        }
        assertTrue(message, predicate())
    }

    private fun notification(): Notification {
        var note: Notification? = null
        instrument.runOnMainSync { note = Invites.notification(context, id, app.store.state.pending[id]) }
        return note!!
    }

    private fun view(): View {
        val note = notification()
        var root: View? = null
        instrument.runOnMainSync { root = note.bigContentView.apply(context, FrameLayout(context)) }
        return root!!
    }

    private fun clickOption(index: Int) {
        instrument.runOnMainSync {
            val options = viewOnMain().findViewById<ViewGroup>(R.id.form_options)
            assertTrue(options.getChildAt(index).performClick())
        }
    }

    private fun viewOnMain(): View = Invites.notification(context, id, app.store.state.pending[id])
        .bigContentView.apply(context, FrameLayout(context))

    private fun next() {
        val before = app.notificationStates[id]!!.page
        instrument.runOnMainSync { assertTrue(viewOnMain().findViewById<View>(R.id.form_next).performClick()) }
        await("Next page did not arrive") { app.notificationStates[id]!!.page == before + 1 }
    }

    private fun reply(action: Notification.Action, text: String) {
        val input = action.remoteInputs.single()
        val fill = Intent()
        RemoteInput.addResultsToIntent(arrayOf(input), fill, Bundle().apply { putCharSequence(input.resultKey, text) })
        action.actionIntent.send(context, 0, fill)
    }

    private fun selectBlue() {
        if (InstrumentationRegistry.getArguments().getString("shadeInput") != "true") {
            clickOption(1)
            return
        }
        // Optional real-shade acceptance: tap Blue on the device within a minute.
        // Some Android versions deliberately redact notification accessibility nodes.
        instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val deadline = SystemClock.elapsedRealtime() + 60_000
        while (SystemClock.elapsedRealtime() < deadline && app.notificationStates[id]?.focus?.get("color") != "blue") {
            SystemClock.sleep(100)
        }
        assertEquals("Tap Blue in the expanded notification shade", "blue", app.notificationStates[id]?.focus?.get("color"))
        instrument.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    @Test fun choicesNotesOtherMultipleFieldsAndSubmissionUseRealNotificationControls() {
        assumeTrue(BuildConfig.ISOLATED_INTEGRATION)
        var safe = false
        instrument.runOnMainSync { safe = !app.paired && app.store.state.pending.isEmpty() }
        assumeTrue("Never change a paired or occupied test package", safe)
        assumeTrue(Invites.allowed(context))
        val oldPreview = app.inviteSettings.showPreview
        try {
            instrument.runOnMainSync {
                app.inviteSettings.showPreview = true
                app.reconcileInbox(listOf(InboxItem(id, "Example", "Shade question: favorite color", System.currentTimeMillis())))
                app.forms[id] = schema
                app.store.invite(id, true)
                Invites.show(context, id, app.store.state.pending[id])
            }
            var note = notification()
            assertEquals(Notification.CATEGORY_MESSAGE, note.category)
            assertEquals(0, note.flags and Notification.FLAG_INSISTENT)
            assertNull(note.fullScreenIntent)
            assertNotNull(note.bigContentView)
            assertFalse(note.actions.any { it.title.toString() == "Answer call" })
            assertFalse(note.publicVersion.extras.toString().contains("favorite"))
            assertEquals("Shade question: favorite color", view().findViewById<TextView>(R.id.form_title).text.toString())
            assertEquals("blue", app.drafts[id]!!.getString("color"))
            selectBlue()
            await("Blue did not become note focus") { app.notificationStates[id]?.focus?.get("color") == "blue" }
            note = notification()
            val blueNote = note.actions.single { !it.remoteInputs.isNullOrEmpty() }
            reply(blueNote, "A calm color")
            await("Note did not arrive through RemoteInput") { app.noteDrafts[id]?.optJSONObject(0)?.optString("text") == "A calm color" }
            clickOption(0)
            await("Radio selection did not change") { app.drafts[id]?.optString("color") == "red" }
            reply(blueNote, "Must not attach to Red")
            instrument.waitForIdleSync()
            assertEquals("A calm color", app.noteDrafts[id]!!.getJSONObject(0).getString("text"))
            next()
            instrument.runOnMainSync { assertFalse(viewOnMain().findViewById<ViewGroup>(R.id.form_options).getChildAt(0).isEnabled) }
            clickOption(1) // Other, on the second option page.
            await("Other did not select") { "color" in app.notificationStates[id]!!.otherPending }
            reply(notification().actions.single { !it.remoteInputs.isNullOrEmpty() }, "Violet")
            await("Other text was not saved") { app.drafts[id]?.optString("color") == "Violet" }
            next()
            clickOption(0)
            await("First checkbox was not saved") { app.drafts[id]?.optJSONArray("extras")?.length() == 1 }
            clickOption(1)
            await("Second checkbox was not saved") { app.drafts[id]?.optJSONArray("extras")?.length() == 2 }
            next()
            reply(notification().actions.single { !it.remoteInputs.isNullOrEmpty() }, "Because it is restful")
            await("Text reply was not saved") { app.drafts[id]?.optString("reason") == "Because it is restful" }
            // No paired transport exists: pressing Submit must report not-sent, never fake success.
            notification().actions.single { it.title.toString() == context.uiString(R.string.notification_submit) }.actionIntent.send()
            await("Disconnected submit did not report failure") { app.formMessage(id)?.contains("not sent", ignoreCase = true) == true }
            assertFalse(id in app.submitting)
            assertTrue(id in app.store.state.pending)
            assertEquals(0, app.noteDrafts[id]!!.length()) // Deselected Blue's note is not submitted with Violet.
            assertEquals("Violet", app.drafts[id]!!.getString("color"))
        } catch (failure: Throwable) {
            context.cacheDir.resolve("shade-failure.png").outputStream().use {
                instrument.uiAutomation.takeScreenshot()?.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            val posted = context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.tag == id }
            throw AssertionError("Shade fixture failed; question notification posted=$posted", failure)
        } finally {
            instrument.runOnMainSync {
                Invites.cancel(context, id)
                app.forms.remove(id); app.drafts.remove(id); app.noteDrafts.remove(id)
                app.notificationStates.remove(id); app.externalDrafts.remove(id); app.formMessages.remove(id)
                app.inviteSettings.showPreview = oldPreview
                app.reconcileInbox(emptyList())
                app.store.state.invited.remove(id); app.store.state.closed.remove(id)
                app.store.state.alerted.remove(id); app.store.state.acknowledged.remove(id)
                app.store.reconcile(emptyList())
            }
        }
    }
}
