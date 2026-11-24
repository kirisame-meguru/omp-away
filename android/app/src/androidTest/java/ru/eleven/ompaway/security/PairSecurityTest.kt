package ru.eleven.ompaway.security

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.cert.CertificateException
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class PairSecurityTest {
    @Test fun invitationAcceptsExplicitHttpsOriginsButRejectsAmbiguousDestinationsAndBadPins() {
        val pin = base64url(ByteArray(32))
        val json = """{"v":1,"url":"https://relay.example","ticket":"valid_ticket","desktopPin":"$pin","nonce":"$pin","secret":"$pin"}"""
        assertEquals("valid_ticket", Invitation.parse(json).ticket)
        assertEquals("https://relay.example", Invitation.parse(json).origin)
        assertEquals("https://other.example:8443", Invitation.parse(json.replace("relay.example", "other.example:8443")).origin)
        for (changed in listOf(json.replace("https://relay.example", "http://relay.example"),
            json.replace("relay.example", "user:password@relay.example"), json.replace("relay.example", "relay.example/path"),
            json.replace("relay.example", "relay.example?q=x"), json.replace("relay.example", "relay.example#fragment"),
            json.replace("\"v\":1", "\"v\":2"), json.replace(pin, pin + "="), json.replace("\"v\":1", "\"v\":1,\"v\":1"))) {
            assertTrue(runCatching { Invitation.parse(changed) }.isFailure)
        }
    }

    @Test fun touchFormsDecodeNestedSpansNullsAndFiniteDecimalConstraints() {
        val envelope = bytesJson("""{
            "type":"form","requestId":"question","form":{
                "sections":[{"blocks":[
                    {"kind":"field","field":{"kind":"choice","name":"choice","options":[
                        {"value":"a","label":[{"text":"Alpha","style":"strong"}],"checked":true}
                    ]}},
                    {"kind":"field","field":{"kind":"text","name":"number","type":"number",
                        "min":0.25,"max":1.5,"value":"0.5"}},
                    {"kind":"table","rows":[[[{"text":"Cell","style":"em"}]]],"headerRows":1}
                ]}],"description":null
            }
        }""".toByteArray(Charsets.UTF_8))
        val form = envelope.getJSONObject("form")
        val blocks = form.getJSONArray("sections").getJSONObject(0).getJSONArray("blocks")
        assertEquals("Alpha", blocks.getJSONObject(0).getJSONObject("field").getJSONArray("options")
            .getJSONObject(0).getJSONArray("label").getJSONObject(0).getString("text"))
        val number = blocks.getJSONObject(1).getJSONObject("field")
        assertEquals(0.25, number.getDouble("min"), 0.0)
        assertEquals(1.5, number.getDouble("max"), 0.0)
        assertEquals("Cell", blocks.getJSONObject(2).getJSONArray("rows").getJSONArray(0)
            .getJSONArray(0).getJSONObject(0).getString("text"))
        assertEquals(1L, blocks.getJSONObject(2).get("headerRows"))
        assertTrue(form.has("description"))
        assertSame(org.json.JSONObject.NULL, form.get("description"))
        val unavailable = parseJson("""{"type":"form","requestId":"question","form":null}""")
        unavailable.fields("type", "requestId", "form")
        assertSame(org.json.JSONObject.NULL, unavailable.get("form"))
        assertEquals(0.01, parseJson("""{"value":1e-2}""").getDouble("value"), 0.0)
    }

    @Test fun jsonBoundsRejectDuplicateNullsNonfiniteNumbersAndExcessiveNesting() {
        for (json in listOf(
            """{"form":null,"form":null}""", """{"form":null,"form":{}}""",
            """{"value":1e999}""", """{"value":-1e999}""",
            """{"value":NaN}""", """{"value":Infinity}""",
            """{"value":9223372036854775808}""",
            """{"value":""" + "[".repeat(33) + "0" + "]".repeat(33) + "}"
        )) assertTrue("Must reject malformed or unbounded JSON", runCatching { parseJson(json) }.isFailure)
        assertTrue(runCatching { bytesJson(byteArrayOf(0x7b, 0x22, 0xc3.toByte(), 0x28, 0x22, 0x3a, 0x30, 0x7d)) }.isFailure)
        assertTrue(runCatching { bytesJson(ByteArray(65537)) }.isFailure)
        assertTrue(runCatching { parseJson(" ".repeat(65537)) }.isFailure)
    }

    @Test fun fractionalJsonSupportDoesNotRelaxLegacyIntegerFields() {
        assertEquals(Long.MAX_VALUE, parseJson("""{"value":9223372036854775807}""").get("value"))
        assertEquals(Long.MIN_VALUE, parseJson("""{"value":-9223372036854775808}""").get("value"))
        val pin = base64url(ByteArray(32))
        val invitation = """{"v":1,"url":"https://relay.example","ticket":"ticket","desktopPin":"$pin","nonce":"$pin","secret":"$pin"}"""
        for (version in listOf("1.0", "1e0", "null"))
            assertTrue(runCatching { Invitation.parse(invitation.replace("\"v\":1", "\"v\":$version")) }.isFailure)
        val id = UUID.randomUUID().toString()
        val inbox = """{"type":"inbox","items":[{"requestId":"$id","project":"Project","question":"Question","createdAt":9223372036854775807}]}"""
        assertEquals(Long.MAX_VALUE, decodeInboxSnapshot(parseJson(inbox)).single().createdAt)
        for (createdAt in listOf("1.5", "1.0", "1e0", "null", "-1"))
            assertTrue(runCatching { decodeInboxSnapshot(parseJson(inbox.replace("9223372036854775807", createdAt))) }.isFailure)
    }

    @Test fun sealedRouteSurvivesReloadButNotTamperingOrReplacement() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val testPrefs = "away.test.${UUID.randomUUID()}"
        val ctx = object : ContextWrapper(base) {
            override fun getSharedPreferences(name: String, mode: Int) = base.getSharedPreferences(testPrefs, mode)
        }
        try {
            val vault = Vault(ctx)
            assertFalse(vault.paired())
            val token = "never-in-plaintext-${UUID.randomUUID()}"
            val pin = base64url(ByteArray(32))
            vault.save(Route("device", token, pin, pin))
            val restored = Vault(ctx)
            assertEquals(token, restored.route()?.token)
            assertNull(restored.route()?.origin)
            restored.migrateOrigin("https://relay.example")
            val migrated = Vault(ctx).route()!!
            assertEquals("https://relay.example", migrated.origin)
            assertEquals(token, migrated.token)
            assertEquals(pin, migrated.phonePin)
            assertEquals(pin, migrated.desktopPin)
            assertEquals("device", migrated.deviceId)
            assertTrue(runCatching { restored.migrateOrigin("https://other.example") }.isFailure)
            assertTrue(runCatching { restored.save(Route("device2", "new bearer", pin, pin)) }.isFailure)
            val prefs = base.getSharedPreferences(testPrefs, Context.MODE_PRIVATE)
            assertFalse(prefs.all.values.any { token in it.toString() })
            vault.setFcm("fcm secret")
            prefs.edit().putString("route", prefs.getString("fcm", null)).commit()
            assertTrue(restored.paired())
            assertTrue(runCatching { restored.route() }.isFailure)
        } finally { base.deleteSharedPreferences(testPrefs) }
    }

    @Test fun roleOrderedEmojiVector() {
        val desktop = ByteArray(32) { it.toByte() }
        val phone = ByteArray(32) { (32 + it).toByte() }
        val nonce = ByteArray(32) { (64 + it).toByte() }
        val expected = "🐷🐶🦁🐶🐰🐢🦁🐳🐙🐷🐻🐸"
        assertEquals(expected, fingerprint(desktop, phone, nonce))
        assertNotEquals(expected, fingerprint(phone, desktop, nonce))
    }

    @Test fun keystoreIdentityIsStableAndSwappedCertificateFails() {
        val aliases = List(2) { "away.test.${UUID.randomUUID()}" }
        try {
            val a = PhoneIdentity.open(aliases[0], true)
            val b = PhoneIdentity.open(aliases[1], true)
            assertNull(a.key.encoded)
            assertEquals(a.pin, PhoneIdentity.open(aliases[0], false).pin)
            val trust = PinnedServer(a.pin)
            trust.checkServerTrusted(arrayOf(a.certificate), "EC")
            try { trust.checkServerTrusted(arrayOf(b.certificate), "EC"); fail("accepted swapped key") }
            catch (_: CertificateException) { }
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            ks.deleteEntry(aliases[0])
            assertTrue(runCatching { PhoneIdentity.open(aliases[0], false) }.isFailure)
        } finally {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); aliases.forEach { deleteEntry(it) } }
        }
    }

    @Test fun enrollmentNeedsLocalAndRemoteConfirmationInOrder() {
        val gate = EnrollmentGate("display")
        assertTrue(runCatching { gate.paired() }.isFailure)
        gate.verify("display")
        assertTrue(runCatching { gate.paired() }.isFailure)
        assertTrue(runCatching { gate.accept("previous dialog") }.isFailure)
        gate.accept("display")
        gate.paired()
        assertTrue(runCatching { gate.paired() }.isFailure)
    }

    @Test fun rejectedOrCancelledEnrollmentCannotComplete() {
        val wrong = EnrollmentGate("own digest")
        assertTrue(runCatching { wrong.verify("substituted digest") }.isFailure)
        assertTrue(runCatching { wrong.accept("substituted digest") }.isFailure)
        val cancelled = EnrollmentGate("own digest")
        cancelled.verify("own digest")
        cancelled.accept("own digest")
        cancelled.cancel()
        assertTrue(runCatching { cancelled.paired() }.isFailure)
    }

    @Test fun fragmentedFramesReassembleAndOversizeFailsBeforePayload() {
        val messages = mutableListOf<String>()
        val frames = FrameDecoder { kind, bytes -> assertEquals(1, kind); messages.add(String(bytes, Charsets.UTF_8)) }
        val wire = byteArrayOf(1, 0, 0, 0, 2, 123, 125)
        wire.forEach { frames.receive(ByteBuffer.wrap(byteArrayOf(it))) }
        assertEquals(listOf("{}"), messages)
        for (header in listOf(byteArrayOf(1, 0, 1, 0, 1), byteArrayOf(2, 0, 0, 0, 0), byteArrayOf(3, 0, 0, 0, 2))) {
            assertTrue(runCatching { FrameDecoder { _, _ -> fail() }.receive(ByteBuffer.wrap(header)) }.isFailure)
        }
    }
}
