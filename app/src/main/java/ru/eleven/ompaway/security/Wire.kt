package ru.eleven.ompaway.security

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader
import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONObject

internal const val RELAY = "https://away.example.invalid"
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
            require(depth <= 5)
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
internal class Invitation private constructor(val ticket: String, val desktop: String, val nonce: String, val secret: String) {
    companion object {
        fun parse(payload: String): Invitation = parseJson(payload).run {
            fields("v", "url", "ticket", "desktopPin", "nonce", "secret")
            require(get("v") == 1L && text("url") == RELAY)
            val ticket = text("ticket")
            require(ticket.length <= 512 && ticket.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' })
            val pin = text("desktopPin"); val nonce = text("nonce"); val secret = text("secret")
            digestBytes(pin); digestBytes(nonce); digestBytes(secret)
            Invitation(ticket, pin, nonce, secret)
        }
    }
}
