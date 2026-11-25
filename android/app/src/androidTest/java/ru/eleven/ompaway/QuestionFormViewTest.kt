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
        view.availability(true, false, null, canSubmit = false)
        assertFalse("Voice may gate submission without locking draft editing", submit(view).isEnabled)
        assertTrue(descendants(view).filterIsInstance<RadioButton>().single { it.text.toString() == "Alpha" }.isEnabled)
        assertTrue(descendants(view).filterIsInstance<EditText>().single { it.text.toString() == "Initial" }.isEnabled)
        view.availability(true, false, null)
        assertEquals("Initial", view.values().getString("reason"))
        assertEquals("a", view.values().getString("choice"))
        assertEquals("[\"x\"]", view.values().getJSONArray("extras").toString())
        assertFalse(descendants(view).filterIsInstance<RadioButton>().single { it.text.toString() == "Unavailable" }.isEnabled)
        descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "Notes for Alpha" }.setText("Raw note")
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

    @Test fun nativeFieldsetShowsItsBodyAndQuestionOnceWithAccessibleChoices() = instrumentation.runOnMainSync {
        val body = "Restart verification. You can answer by touch or use voice to test call completion."
        val question = "Did this question appear correctly?"
        val form = JSONObject("""{"sections":[
            {"title":[],"blocks":[{"kind":"text","spans":[{"text":"$body"}]}]},
            {"title":[{"text":"$question"}],"blocks":[{"kind":"field","field":{
                "kind":"choice","name":"result","question":"$question","label":[],"other":true,"options":[
                    {"value":"yes","label":[{"text":"Yes, it looks correct"}],"checked":true},
                    {"value":"no","label":[{"text":"No, something is wrong"}]}
                ]}}]}
        ]}""")
        val view = QuestionFormView(instrumentation.targetContext, form, null, null) { _, _ -> }
        val labels = descendants(view).filterIsInstance<android.widget.TextView>().map { it.text.toString() }
        assertEquals(1, labels.count { it == body })
        assertEquals(1, labels.count { it == question })
        assertEquals(1, labels.count { it == "Yes, it looks correct" })
        assertEquals(1, labels.count { it == "No, something is wrong" })
        assertEquals(1, labels.count { it == "Other" })
        assertEquals("yes", view.values().getString("result"))
        assertTrue(descendants(view).filterIsInstance<RadioButton>().all { it.contentDescription.toString().startsWith(question) })
    }

    @Test fun contextMetadataIsNotRepeatedButAuthoredContentAndRequiredLabelsRemain() = instrumentation.runOnMainSync {
        val form = JSONObject("""{"title":"Integration check","description":"A short body.","sections":[
            {"title":[],"blocks":[
                {"kind":"text","heading":true,"spans":[{"text":"Integration "},{"text":"check","style":"strong"}]},
                {"kind":"text","spans":[{"text":"A short body."}]}
            ]},
            {"title":[{"text":"Verification"}],"blocks":[{"kind":"field","field":{
                "kind":"text","name":"answer","question":"Verification","required":true,"value":"Ready"}
            }]}
        ]}""")
        val view = QuestionFormView(instrumentation.targetContext, form, null, null) { _, _ -> }
        val labels = descendants(view).filterIsInstance<android.widget.TextView>().map { it.text.toString() }
        assertEquals(1, labels.count { it == "Integration check" })
        assertEquals(1, labels.count { it == "A short body." })
        assertEquals(1, labels.count { it == "Verification *" })
        assertFalse(labels.contains("Verification"))
        assertEquals("Verification *", descendants(view).filterIsInstance<EditText>().single().contentDescription)
        form.put("title", "Unique context").put("description", "A separate explanation.")
        val unique = QuestionFormView(instrumentation.targetContext, form, null, null) { _, _ -> }
        val uniqueLabels = descendants(unique).filterIsInstance<android.widget.TextView>().map { it.text.toString() }
        assertEquals(1, uniqueLabels.count { it == "Unique context" })
        assertEquals(1, uniqueLabels.count { it == "A separate explanation." })
        assertEquals(1, uniqueLabels.count { it == "Integration check" })
    }

    @Test fun repeatedAuthoredParagraphsAndIndependentFieldsAreNeverGloballyDeduplicated() = instrumentation.runOnMainSync {
        val form = JSONObject("""{"description":"Repeat intentionally.","sections":[
            {"title":[],"blocks":[
                {"kind":"text","spans":[{"text":"Repeat intentionally."}]},
                {"kind":"text","spans":[{"text":"Repeat intentionally."}]}
            ]},
            {"title":[{"text":"Shared label"}],"blocks":[
                {"kind":"field","field":{"kind":"text","name":"first","question":"Shared label","value":"First"}},
                {"kind":"field","field":{"kind":"text","name":"second","question":"Shared label","value":"Second"}}
            ]},
            {"title":[{"text":"Independent section"}],"blocks":[
                {"kind":"field","field":{"kind":"text","name":"third","question":"Independent section","required":true}}
            ]},
            {"title":[{"text":"Independent section"}],"blocks":[
                {"kind":"field","field":{"kind":"text","name":"fourth","question":"Independent section","required":true}}
            ]}
        ]}""")
        val view = QuestionFormView(instrumentation.targetContext, form, null, null) { _, _ -> }
        val labels = descendants(view).filterIsInstance<android.widget.TextView>().map { it.text.toString() }
        assertEquals(2, labels.count { it == "Repeat intentionally." })
        assertEquals(3, labels.count { it == "Shared label" })
        assertEquals(2, labels.count { it == "Independent section *" })
        assertEquals("First", view.values().getString("first"))
        assertEquals("Second", view.values().getString("second"))
        assertEquals(4, descendants(view).filterIsInstance<EditText>().size)
    }

    @Test fun visibleFieldCaptionsReplaceMatchingMetadataWithoutDroppingRequiredSemantics() = instrumentation.runOnMainSync {
        val form = schema(
            """{"kind":"text","name":"first","question":"Standalone label","required":true}""",
            """{"kind":"text","name":"second","question":"Standalone label","required":true}"""
        ).put("title", "Standalone label").put("description", "Standalone label")
        val view = QuestionFormView(instrumentation.targetContext, form, null, null) { _, _ -> }
        val labels = descendants(view).filterIsInstance<android.widget.TextView>().map { it.text.toString() }
        assertFalse(labels.contains("Standalone label"))
        assertEquals(2, labels.count { it == "Standalone label *" })
        assertTrue(descendants(view).filterIsInstance<EditText>().all { it.contentDescription == "Standalone label *" })
    }

    @Test fun textOnlyAndMetadataOnlyFormsKeepTheirUniqueContext() = instrumentation.runOnMainSync {
        for (form in listOf(
            JSONObject("""{"title":"Context only","description":"A separate explanation.","sections":[]}"""),
            JSONObject("""{"sections":[{"title":[],"blocks":[{"kind":"text","spans":[{"text":"Context only"}]}]}]}""")
        )) {
            val view = QuestionFormView(instrumentation.targetContext, form, null, null) { _, _ -> }
            val labels = descendants(view).filterIsInstance<android.widget.TextView>().map { it.text.toString() }
            assertEquals(1, labels.count { it == "Context only" })
            assertEquals(0, view.values().length())
            assertEquals(1, labels.count { it == "Submit answer" })
        }
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
