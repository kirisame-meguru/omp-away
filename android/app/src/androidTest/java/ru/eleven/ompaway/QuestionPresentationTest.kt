package ru.eleven.ompaway

import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** Calls the production native composition without starting the inbox lifecycle, media or transport. */
class QuestionPresentationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val question = "Did this question appear correctly?"
    private val body = "Restart verification. You can answer by touch or use voice to test call completion."

    private fun form() = JSONObject("""{"sections":[
        {"title":[],"blocks":[{"kind":"text","spans":[{"text":"$body"}]}]},
        {"title":[{"text":"$question"}],"blocks":[{"kind":"field","field":{
            "kind":"choice","name":"result","question":"$question","label":[],"other":true,"options":[
                {"value":"yes","label":[{"text":"Yes, it looks correct"}],"checked":true},
                {"value":"no","label":[{"text":"No, something is wrong"}]}
            ]}}]}
    ]}""")

    @Test fun fullFormIsTheOnlyQuestionPresentationOnHomeAndDetails() = fixture { fixture ->
        val schema = form()
        val home = fixture.render(schema, details = false)
        assertQuestionOnce(home)
        val view = descendants(home).filterIsInstance<QuestionFormView>().single()
        descendants(view).filterIsInstance<RadioButton>().single { it.text.toString() == "No, something is wrong" }.isChecked = true
        val details = fixture.render(schema, details = true)
        assertQuestionOnce(details)
        assertSame("Navigation should retain the edited native form", view, descendants(details).filterIsInstance<QuestionFormView>().single())
        assertEquals("no", view.values().getString("result"))
        assertFalse(descendants(details).any { it is QuestionDetailView })
        assertFalse(texts(details).any { it.contains("Legacy context") || it.contains("Read only") })
    }

    @Test fun missingMalformedAndEmptyFormsUseOneLegacyPresentation() = fixture { fixture ->
        // A formerly usable form must not leak through when its replacement cannot be rendered.
        fixture.render(form(), details = true)
        for (schema in listOf(null, JSONObject(), JSONObject("""{"sections":[]}"""),
            JSONObject("""{"sections":[{"blocks":[{"kind":"unsupported"}]}]}"""))) {
            val home = fixture.render(schema, details = false)
            assertEquals(1, texts(home).count { it == question })
            assertFalse(descendants(home).any { it is QuestionFormView })
            val details = fixture.render(schema, details = true)
            assertEquals(1, descendants(details).filterIsInstance<QuestionDetailView>().size)
            assertFalse(descendants(details).any { it is QuestionFormView })
            assertFalse(texts(details).contains(question))
            assertEquals(1, texts(details).count { it == "1. $question" })
            assertEquals(1, texts(details).count { it == "1. Yes, it looks correct" })
            assertEquals(1, texts(details).count { it == "Legacy context" })
        }
        fixture.app.store.state.details.clear()
        val summaryOnly = fixture.render(null, details = true)
        assertEquals("The legacy view already owns its summary fallback", 1, texts(summaryOnly).count { it == question })
        assertTrue(texts(summaryOnly).any { it.startsWith("Summary only") })
    }

    @Test fun offlineCompositionNeverShowsCachedFormsSummariesOrLegacyChoices() = fixture { fixture ->
        val schema = form()
        fixture.render(schema, details = false)
        for (details in listOf(false, true)) {
            val offline = fixture.render(schema, details = details, verified = false)
            val labels = texts(offline)
            assertFalse(descendants(offline).any { it is QuestionFormView })
            assertFalse(labels.any { it.contains(question) || it.contains(body) || it.contains("Yes, it looks correct") || it.contains("Legacy context") })
            assertTrue(labels.any { it.contains("Reconnect", ignoreCase = true) })
        }
    }

    private fun assertQuestionOnce(view: View) {
        val labels = texts(view)
        assertEquals(1, descendants(view).filterIsInstance<QuestionFormView>().size)
        assertFalse(descendants(view).any { it is QuestionDetailView })
        assertEquals(1, labels.count { it == question })
        assertEquals(1, labels.count { it == body })
        assertEquals(1, labels.count { it == "Yes, it looks correct" })
        assertEquals(1, labels.count { it == "No, something is wrong" })
    }

    private fun fixture(test: (Fixture) -> Unit) = instrumentation.runOnMainSync {
        val context = instrumentation.targetContext
        val preferenceName = "question-presentation-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int) = super.getSharedPreferences(preferenceName, mode)
        }
        val app = Gateway()
        Gateway::class.java.getDeclaredField("store").apply { isAccessible = true }.set(app, InboxStore(isolated))
        // Instrumentation attaches this Activity to the in-memory application. No onCreate/onResume,
        // Firebase lookup, PairedChannel, invitation action or render loop is invoked.
        @Suppress("DEPRECATION")
        val activity = instrumentation.newActivity(InboxActivity::class.java, context, null, app,
            Intent(context, InboxActivity::class.java), ActivityInfo().apply {
                applicationInfo = context.applicationInfo; name = InboxActivity::class.java.name
            }, "Question fixture", null, null, null) as InboxActivity
        activity.setTheme(android.R.style.Theme_Material_Light_NoActionBar)
        val fixture = Fixture(activity, app)
        try { test(fixture) }
        finally {
            assertNull("Composition must not create a transport session", Gateway::class.java.getDeclaredField("session").apply { isAccessible = true }.get(app))
            assertNull(app.callVisual)
            context.deleteSharedPreferences(preferenceName)
        }
    }

    private inner class Fixture(val activity: InboxActivity, val app: Gateway) {
        private val item = Pending(UUID.randomUUID().toString(), "Fixture", question, 1L)
        private val target = InboxActivity::class.java.getDeclaredField("contentTarget").apply { isAccessible = true }
        private val verifiedField = Gateway::class.java.getDeclaredField("verifiedInbox").apply { isAccessible = true }
        private val render = InboxActivity::class.java.getDeclaredMethod("renderQuestionBody", Pending::class.java, Boolean::class.javaPrimitiveType)
            .apply { isAccessible = true }

        init {
            app.store.state.pending[item.id] = item
            app.store.state.details[item.id] = QuestionDisplay(1, "Legacy context", listOf(
                DisplayField("f0", question, "single", false, options = listOf(
                    DisplayOption("yes", "Yes, it looks correct", false), DisplayOption("no", "No, something is wrong", false)))
            ))
        }

        fun render(schema: JSONObject?, details: Boolean, verified: Boolean = true): LinearLayout {
            verifiedField.setBoolean(app, verified)
            if (schema == null) {
                app.forms.remove(item.id)
                // Represents an already-received null-form receipt; no fetch/transport is needed.
                app.formMessages[item.id] = "Touch form unavailable."
            } else {
                app.forms[item.id] = schema
                app.formMessages.remove(item.id)
            }
            val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
            target.set(activity, column)
            render.invoke(activity, item, details)
            column.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            column.layout(0, 0, column.measuredWidth, column.measuredHeight)
            return column
        }
    }

    private fun descendants(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
    private fun texts(view: View) = descendants(view).filterIsInstance<TextView>().map { it.text.toString() }
}
