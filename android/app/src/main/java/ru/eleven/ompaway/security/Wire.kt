package ru.eleven.ompaway.security

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader
import java.nio.ByteBuffer
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject
import ru.eleven.ompaway.validId

internal fun relayOrigin(value: String): String {
    require(value.length in 1..2048 && value.none { it.isWhitespace() || it == '\\' })
    val uri = URI(value)
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") && uri.rawQuery == null && uri.rawFragment == null &&
        (uri.port == -1 || uri.port in 1..65535))
    return URI("https", null, uri.host, uri.port, null, null, null).toASCIIString()
}
internal fun JSONObject.text(key: String): String = (get(key) as String).also { require(it.isNotEmpty()) }
internal fun JSONObject.fields(vararg names: String) { require(length() == names.size && names.all { has(it) }) }
internal fun bytesJson(bytes: ByteArray): JSONObject {
    require(bytes.size in 1..65536)
    return parseJson(Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString())
}
internal fun parseJson(text: String): JSONObject {
    require(text.length in 1..65536)
    return JsonReader(StringReader(text)).use { reader ->
        fun value(depth: Int): Any {
            require(depth <= 7) // question.display.fields[].options[].label
            return when (reader.peek()) {
                JsonToken.BEGIN_OBJECT -> JSONObject().apply {
                    reader.beginObject()
                    while (reader.hasNext()) { val key = reader.nextName(); require(!has(key)); put(key, value(depth + 1)) }
                    reader.endObject()
                }
                JsonToken.BEGIN_ARRAY -> JSONArray().apply { reader.beginArray(); while (reader.hasNext()) put(value(depth + 1)); reader.endArray() }
                JsonToken.STRING -> reader.nextString()
                JsonToken.NUMBER -> reader.nextString().toLong()
                JsonToken.BOOLEAN -> reader.nextBoolean()
                else -> error("Unexpected JSON value")
            }
        }
        val obj = value(0) as JSONObject
        require(reader.peek() == JsonToken.END_DOCUMENT)
        obj
    }
}
internal class Invitation private constructor(val ticket: String, val desktop: String, val nonce: String, val secret: String, val origin: String) {
    companion object {
        fun parse(payload: String): Invitation = parseJson(payload).run {
            fields("v", "url", "ticket", "desktopPin", "nonce", "secret")
            require(get("v") == 1L)
            val origin = relayOrigin(text("url"))
            val ticket = text("ticket")
            require(ticket.length <= 512 && ticket.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' })
            val pin = text("desktopPin"); val nonce = text("nonce"); val secret = text("secret")
            digestBytes(pin); digestBytes(nonce); digestBytes(secret)
            Invitation(ticket, pin, nonce, secret, origin)
        }
    }
}

/** Decode the entire authoritative snapshot before publishing any state changes. */
internal fun decodeInboxSnapshot(message: JSONObject): List<InboxItem> {
    message.fields("type", "items")
    require(message.text("type") == "inbox")
    val items = message.getJSONArray("items")
    val ids = HashSet<String>()
    return List(items.length()) { index -> items.getJSONObject(index).run {
        if (has("session")) fields("requestId", "project", "question", "createdAt", "session")
        else fields("requestId", "project", "question", "createdAt")
        val id = text("requestId"); require(validId(id) && ids.add(id))
        val project = get("project") as String
        val question = get("question") as String
        val session = if (has("session")) get("session") as String else null
        require(project.length <= 8192 && question.length <= 8192 && (session == null || session.length <= 128))
        InboxItem(id, project, question, (get("createdAt") as Long).also { require(it >= 0) }, session)
    } }
}
