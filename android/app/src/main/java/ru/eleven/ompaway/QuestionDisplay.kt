package ru.eleven.ompaway

import org.json.JSONObject

private val displayKeys = setOf("v", "context", "fields")
private val fieldKeys = setOf("id", "label", "kind", "required")
private val optionalFieldKeys = setOf("description", "other", "inputType", "placeholder", "options")
private val optionKeys = setOf("id", "label", "disabled")

/** Display-only identities. None of these strings are native submission values. */
data class DisplayOption(val id: String, val label: String, val disabled: Boolean)
data class DisplayField(
    val id: String, val label: String, val kind: String, val required: Boolean,
    val description: String? = null, val other: Boolean = false,
    val inputType: String? = null, val placeholder: String? = null,
    val options: List<DisplayOption> = emptyList()
)
data class QuestionDisplay(val v: Int, val context: String, val fields: List<DisplayField>)

private fun validDisplayText(value: String): Boolean {
    if (value.length > 8192) return false
    var index = 0
    while (index < value.length) {
        val char = value[index++]
        if (char == '\u0000' || char in '\uDC00'..'\uDFFF') return false
        if (char in '\uD800'..'\uDBFF') {
            if (index == value.length || value[index] !in '\uDC00'..'\uDFFF') return false
            index++
        }
    }
    return true
}

/** Unknown versions and malformed metadata deliberately degrade to the summary, never cached choices. */
internal fun decodeQuestionDisplay(value: JSONObject?): QuestionDisplay? = try {
    requireNotNull(value)
    require(value.toString().toByteArray(Charsets.UTF_8).size <= 49152)
    fun JSONObject.keysAre(required: Set<String>, optional: Set<String> = emptySet()) {
        require(required.all { has(it) } && keys().asSequence().all { it in required || it in optional })
    }
    fun JSONObject.label(key: String): String = (get(key) as String).also {
        require(validDisplayText(it))
    }
    fun JSONObject.optionalLabel(key: String) = if (has(key)) label(key) else null
    value.keysAre(displayKeys)
    require(value.get("v") == 1 || value.get("v") == 1L)
    val fields = value.getJSONArray("fields")
    require(fields.length() in 1..32)
    QuestionDisplay(1, value.label("context"), List(fields.length()) { index ->
        val field = fields.getJSONObject(index)
        field.keysAre(fieldKeys, optionalFieldKeys)
        val id = field.get("id") as String; require(id == "f${index + 1}")
        val kind = field.get("kind") as String
        require(kind == "single" || kind == "multi" || kind == "text")
        val options = if (kind == "text") {
            require(!field.has("options") && !field.has("other"))
            null
        } else {
            require(!field.has("inputType") && !field.has("placeholder"))
            field.getJSONArray("options").also { require(it.length() <= 256) }
        }
        DisplayField(id, field.label("label"), kind, field.get("required") as Boolean,
            field.optionalLabel("description"), if (field.has("other")) field.get("other") as Boolean else false,
            field.optionalLabel("inputType"), field.optionalLabel("placeholder"),
            List(options?.length() ?: 0) { optionIndex ->
                val option = options!!.getJSONObject(optionIndex)
                option.keysAre(optionKeys)
                val optionId = option.get("id") as String; require(optionId == "o${optionIndex + 1}")
                DisplayOption(optionId, option.label("label"), option.get("disabled") as Boolean)
            })
    })
} catch (_: Exception) { null }
