package ru.eleven.ompaway

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import ru.eleven.ompaway.security.bytesJson

import ru.eleven.ompaway.security.decodeInboxSnapshot
@RunWith(AndroidJUnit4::class)
class QuestionDisplayTest {
    private fun display() = JSONObject("""{"v":1,"context":"日本語 — choose","fields":[{"id":"f1","label":"Choose","kind":"multi","required":true,"description":"Several allowed","other":true,"options":[{"id":"o1","label":"Same","disabled":false},{"id":"o2","label":"Same","disabled":true}]},{"id":"f2","label":"Explain","kind":"text","required":false,"inputType":"textarea","placeholder":"Write here"}]}""")

    @Test fun preservesDuplicateLabelsDisabledOtherAndMultipleFieldsThroughRealFrameParser() {
        val frame = JSONObject().put("type", "question").put("requestId", "request").put("display", display())
        val decoded = decodeQuestionDisplay(bytesJson(frame.toString().toByteArray()).getJSONObject("display"))!!
        assertEquals("日本語 — choose", decoded.context)
        assertEquals(2, decoded.fields.size)
        assertEquals(listOf("o1", "o2"), decoded.fields[0].options.map { it.id })
        assertTrue(decoded.fields[0].options[1].disabled)
        assertTrue(decoded.fields[0].other)
        assertEquals("textarea", decoded.fields[1].inputType)
    }

    @Test fun missingUnsupportedMalformedAndDuplicateIdentityUseSummaryFallback() {
        assertNull(decodeQuestionDisplay(null))
        assertNull(decodeQuestionDisplay(display().put("v", 1.5)))
        assertNull(decodeQuestionDisplay(display().put("v", 2)))
        assertNull(decodeQuestionDisplay(display().put("v", "1")))
        assertNull(decodeQuestionDisplay(display().put("privateToken", "hidden")))
        val missing = display(); missing.getJSONArray("fields").getJSONObject(0).remove("required")
        assertNull(decodeQuestionDisplay(missing))
        val duplicate = display(); duplicate.getJSONArray("fields").getJSONObject(0).getJSONArray("options").getJSONObject(1).put("id", "o1")
        assertNull(decodeQuestionDisplay(duplicate))
        val malformed = display(); malformed.getJSONArray("fields").getJSONObject(0).getJSONArray("options").getJSONObject(0).put("disabled", "false")
        assertNull(decodeQuestionDisplay(malformed))
        val duplicateField = display(); duplicateField.getJSONArray("fields").getJSONObject(1).put("id", "f1")
        assertNull(decodeQuestionDisplay(duplicateField))
        val unknownKind = display(); unknownKind.getJSONArray("fields").getJSONObject(0).put("kind", "submit")
        assertNull(decodeQuestionDisplay(unknownKind))
    }

    @Test fun rejectsEmptyFieldsAndKindSpecificMetadataCombinations() {
        assertNull(decodeQuestionDisplay(display().put("fields", JSONArray())))
        for ((key, value) in listOf("options" to JSONArray(), "other" to false, "other" to true)) {
            val invalid = display()
            invalid.getJSONArray("fields").getJSONObject(1).put(key, value)
            assertNull("Text must reject $key", decodeQuestionDisplay(invalid))
        }
        for (kind in listOf("single", "multi")) {
            for (key in listOf("inputType", "placeholder")) {
                val invalid = display()
                invalid.getJSONArray("fields").getJSONObject(0).put("kind", kind).put(key, "")
                assertNull("Choice must reject $key", decodeQuestionDisplay(invalid))
            }
            val missing = display()
            missing.getJSONArray("fields").getJSONObject(0).put("kind", kind).remove("options")
            assertNull(decodeQuestionDisplay(missing))
            val empty = display()
            empty.getJSONArray("fields").getJSONObject(0).put("kind", kind).put("options", JSONArray())
            assertNotNull(decodeQuestionDisplay(empty))
        }
        val wrongField = display(); wrongField.getJSONArray("fields").getJSONObject(0).put("id", "f3")
        assertNull(decodeQuestionDisplay(wrongField))
        val wrongOption = display(); wrongOption.getJSONArray("fields").getJSONObject(0).getJSONArray("options").getJSONObject(0).put("id", "o3")
        assertNull(decodeQuestionDisplay(wrongOption))
    }

    @Test fun rejectsUnpairedSurrogatesInEveryDisplayTextPositionButAcceptsAstralUnicode() {
        val locations: List<(JSONObject, String) -> Unit> = listOf(
            { doc, text -> doc.put("context", text); Unit },
            { doc, text -> doc.getJSONArray("fields").getJSONObject(0).put("label", text); Unit },
            { doc, text -> doc.getJSONArray("fields").getJSONObject(0).put("description", text); Unit },
            { doc, text -> doc.getJSONArray("fields").getJSONObject(1).put("inputType", text); Unit },
            { doc, text -> doc.getJSONArray("fields").getJSONObject(1).put("placeholder", text); Unit },
            { doc, text -> doc.getJSONArray("fields").getJSONObject(0).getJSONArray("options").getJSONObject(0).put("label", text); Unit }
        )
        for (location in locations) {
            for (text in listOf("\uD800", "\uDC00", "\uD800x", "\uD800\uD800", "\uDC00\uD800")) {
                val invalid = display(); location(invalid, text)
                assertNull(decodeQuestionDisplay(invalid))
            }
            val valid = display(); location(valid, "\uD83D\uDE80".repeat(4096))
            assertNotNull(decodeQuestionDisplay(valid))
            val over = display(); location(over, "\uD83D\uDE80".repeat(4097))
            assertNull(decodeQuestionDisplay(over))
        }
        val escaped = """{"type":"question","requestId":"request","display":{"v":1,"context":"\ud800","fields":[{"id":"f1","label":"Q","kind":"text","required":false}]}}"""
        assertNull(runCatching { decodeQuestionDisplay(bytesJson(escaped.toByteArray()).getJSONObject("display")) }.getOrNull())
    }

    @Test fun exactTextAndOptionBoundsRemainReadableAndFrameBoundIsInclusive() {
        val bounded = display()
        bounded.getJSONArray("fields").getJSONObject(1).put("label", "x".repeat(8192))
        val options = JSONArray()
        repeat(256) { options.put(JSONObject().put("id", "o${it + 1}").put("label", "Choice").put("disabled", false)) }
        bounded.getJSONArray("fields").getJSONObject(0).put("options", options)
        val decoded = decodeQuestionDisplay(bounded)!!
        assertEquals(8192, decoded.fields[1].label.length)
        assertEquals(256, decoded.fields[0].options.size)
        assertEquals(65528, bytesJson(("{\"x\":\"" + "x".repeat(65528) + "\"}").toByteArray()).getString("x").length)
        val tooDeep = "{\"x\":".repeat(33) + "0" + "}".repeat(33)
        assertTrue(runCatching { bytesJson(tooDeep.toByteArray()) }.isFailure)
    }

    @Test fun inboxAssociationRejectsDuplicateIdsAndMalformedSessionWithoutPartialSnapshots() {
        fun frame(rows: JSONArray) = bytesJson(JSONObject().put("type", "inbox").put("items", rows).toString().toByteArray())
        fun row(id: String) = JSONObject().put("requestId", id).put("project", "Project").put("question", "Actual question")
            .put("createdAt", 12L)
        val legacy = decodeInboxSnapshot(frame(JSONArray().put(row("one")))).single()
        assertNull(legacy.session)
        assertEquals("Actual question", legacy.question)
        val modern = decodeInboxSnapshot(frame(JSONArray().put(row("one").put("session", "Session")))).single()
        assertEquals("Session", modern.session)
        assertNull(modern.call)
        val calling = decodeInboxSnapshot(frame(JSONArray().put(row("one").put("call", "one-use-token")))).single()
        assertEquals("one-use-token", calling.call)
        for (invalid in listOf("", "bad token", "x".repeat(129), "é", 1)) {
            assertTrue(runCatching { decodeInboxSnapshot(frame(JSONArray().put(row("one").put("call", invalid)))) }.isFailure)
        }
        assertTrue(runCatching { decodeInboxSnapshot(frame(JSONArray().put(row("one")).put(row("one")))) }.isFailure)
        assertTrue(runCatching { decodeInboxSnapshot(frame(JSONArray().put(row("one")).put(row("two").put("session", "x".repeat(129))))) }.isFailure)
        assertTrue(runCatching { decodeInboxSnapshot(frame(JSONArray().put(row("bad id")))) }.isFailure)
    }

    @Test fun boundsApplyToFieldsOptionsTextUtf8AndWholeFrames() {
        assertNull(decodeQuestionDisplay(display().put("context", "x".repeat(8193))))
        val manyFields = JSONArray(); repeat(33) { manyFields.put(JSONObject().put("id", "f${it + 1}").put("label", "Q").put("kind", "text").put("required", false)) }
        assertNull(decodeQuestionDisplay(display().put("fields", manyFields)))
        manyFields.remove(32)
        assertEquals(32, decodeQuestionDisplay(display().put("fields", manyFields))!!.fields.size)
        val manyOptions = display(); val options = JSONArray()
        repeat(257) { options.put(JSONObject().put("id", "o${it + 1}").put("label", "A").put("disabled", false)) }
        manyOptions.getJSONArray("fields").getJSONObject(0).put("options", options)
        assertNull(decodeQuestionDisplay(manyOptions))
        options.remove(256)
        assertEquals(256, decodeQuestionDisplay(manyOptions)!!.fields[0].options.size)
        val utf8 = display(); utf8.put("context", "界".repeat(8192))
        utf8.getJSONArray("fields").getJSONObject(0).put("label", "界".repeat(8192))
        assertNull(decodeQuestionDisplay(utf8))
        assertThrows(IllegalArgumentException::class.java) { bytesJson(ByteArray(65537)) }
    }
}
