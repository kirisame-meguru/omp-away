package ru.eleven.ompaway

import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.RadioButton
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QuestionFormViewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun schema(vararg fields: String) = JSONObject().put("optionNotes", true)
        .put("sections", JSONArray().put(JSONObject().put("blocks", JSONArray().also { blocks ->
            for (field in fields) blocks.put(JSONObject().put("kind", "field").put("field", JSONObject(field)))
        })))

    private fun descendants(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()

    private fun submit(view: View) = descendants(view).filterIsInstance<Button>().single { it.text.toString() == "Submit answer" }

    @Test fun defaultsDisabledOptionsAndRawNotesMatchTheDesktopContract() = instrumentation.runOnMainSync {
        val schema = schema(
            """{"kind":"text","name":"reason","question":"Reason","value":"Initial","required":true}""",
            """{"kind":"choice","name":"choice","question":"Choose","options":[
                {"value":"a","label":[{"text":"Alpha"}],"checked":true},
                {"value":"b","label":[{"text":"Beta"}],"checked":false},
                {"value":"c","label":[{"text":"Unavailable"}],"checked":true,"disabled":true}]}""",
            """{"kind":"choice","name":"extras","question":"Extras","multi":true,"array":true,"options":[
                {"value":"x","label":[{"text":"Extra X"}],"checked":true},
                {"value":"y","label":[{"text":"Extra Y"}],"checked":false}]}"""
        )
        var sentValues: JSONObject? = null
        var sentNotes: JSONArray? = null
        val view = QuestionFormView(instrumentation.targetContext, schema, null, null) { values, notes ->
            sentValues = values; sentNotes = notes
        }
        view.availability(true, false, null)
        assertEquals("Initial", view.values().getString("reason"))
        assertEquals("a", view.values().getString("choice"))
        assertEquals("[\"x\"]", view.values().getJSONArray("extras").toString())
        assertFalse(descendants(view).filterIsInstance<RadioButton>().single { it.text.toString() == "Unavailable" }.isEnabled)
        descendants(view).filterIsInstance<Button>().single { it.text.toString() == "Note: Alpha" }.performClick()
        descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "Note for Alpha" }.setText("Raw note")
        submit(view).performClick()
        assertEquals("a", sentValues!!.getString("choice"))
        val note = sentNotes!!.getJSONObject(0)
        assertEquals(3, note.length())
        assertEquals("choice", note.getString("name"))
        assertEquals("a", note.getString("value"))
        assertEquals("Raw note", note.getString("text"))
        assertFalse(note.has("label"))
        val restored = QuestionFormView(instrumentation.targetContext, schema, view.values(), view.notes()) { _, _ -> }
        assertEquals(view.values().toString(), restored.values().toString())
        assertEquals(view.notes().toString(), restored.notes().toString())
    }

    @Test fun requiredLengthAndNumericValidationPrecedeSubmission() = instrumentation.runOnMainSync {
        var submissions = 0
        val view = QuestionFormView(instrumentation.targetContext, schema(
            """{"kind":"text","name":"reason","question":"Reason","required":true,"minLength":3,"maxLength":5}""",
            """{"kind":"text","name":"count","question":"Count","type":"number","min":1,"max":3,"value":"2"}"""
        ), null, null) { _, _ -> submissions++ }
        val reason = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "Reason *" }
        val count = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "Count" }
        submit(view).performClick()
        assertNotNull(reason.error)
        reason.setText("ab"); submit(view).performClick()
        reason.setText("abcdef"); submit(view).performClick()
        reason.setText("valid"); count.setText("4"); submit(view).performClick()
        assertNotNull(count.error)
        assertEquals(0, submissions)
        count.setText("2"); submit(view).performClick()
        assertEquals(1, submissions)
        view.availability(true, true, "Submission not confirmed")
        assertTrue(descendants(view).filterIsInstance<EditText>().none { it.isEnabled })
        assertFalse(descendants(view).filterIsInstance<Button>().single { it.text.toString() == "Awaiting desktop confirmation" }.isEnabled)
    }

    @Test fun uncheckedScalarDraftDoesNotReapplyItsCheckedDefault() = instrumentation.runOnMainSync {
        val schema = schema("""{"kind":"choice","name":"flag","question":"Flag","multi":true,"array":false,"options":[
            {"value":"on","label":[{"text":"Enabled"}],"checked":true}]}""")
        val view = QuestionFormView(instrumentation.targetContext, schema, null, null) { _, _ -> }
        assertEquals("on", view.values().getString("flag"))
        descendants(view).filterIsInstance<CheckBox>().single().isChecked = false
        assertFalse(view.values().has("flag"))
        val restored = QuestionFormView(instrumentation.targetContext, schema, view.values(), view.notes()) { _, _ -> }
        assertFalse(restored.values().has("flag"))
        assertFalse(descendants(restored).filterIsInstance<CheckBox>().single().isChecked)
    }

    @Test fun otherAnswerIsTrimmedAndItsNoteFollowsTheSelectedValue() = instrumentation.runOnMainSync {
        var submissions = 0
        val view = QuestionFormView(instrumentation.targetContext, schema(
            """{"kind":"choice","name":"choice","question":"Choose","required":true,"other":true,"options":[
                {"value":"a","label":[{"text":"Alpha"}]}]}"""
        ), null, null) { _, _ -> submissions++ }
        submit(view).performClick()
        assertEquals(0, submissions)
        descendants(view).filterIsInstance<RadioButton>().single { it.text.toString() == "Other" }.isChecked = true
        submit(view).performClick()
        assertEquals(0, submissions)
        descendants(view).filterIsInstance<EditText>().single { it.hint == "Your answer" }.setText("  Custom  ")
        descendants(view).filterIsInstance<Button>().single { it.text.toString() == "Note: Other" }.performClick()
        descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "Note for Other" }.setText("Explanation")
        submit(view).performClick()
        assertEquals(1, submissions)
        assertEquals("Custom", view.values().getString("choice"))
        assertEquals("Custom", view.notes().getJSONObject(0).getString("value"))
        descendants(view).filterIsInstance<RadioButton>().single { it.text.toString() == "Alpha" }.isChecked = true
        assertEquals(0, view.notes().length())
    }
}
