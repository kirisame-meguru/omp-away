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
    @Test fun invitationCannotRedirectTicketsOrIgnoreVersionAndPinFormat() {
        val pin = base64url(ByteArray(32))
        val json = """{"v":1,"url":"https://away.example.invalid","ticket":"valid_ticket","desktopPin":"$pin","nonce":"$pin","secret":"$pin"}"""
        assertEquals("valid_ticket", Invitation.parse(json).ticket)
        for (changed in listOf(json.replace("away.example.invalid", "away.example.invalid.other"), json.replace("\"v\":1", "\"v\":2"),
            json.replace(pin, pin + "="), json.replace("\"v\":1", "\"v\":1,\"v\":1"))) {
            assertTrue(runCatching { Invitation.parse(changed) }.isFailure)
        }
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
