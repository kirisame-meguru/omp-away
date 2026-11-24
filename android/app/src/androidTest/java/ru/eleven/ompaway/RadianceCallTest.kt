package ru.eleven.ompaway

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Assert.*
import org.junit.Test

class RadianceCallTest {
    @Test fun actualAudioDrivesTheIntegratedScreenWithoutReplacingThePairedInbox() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(BuildConfig.ISOLATED_INTEGRATION) { "Run with -PisolatedIntegration=true, never over the signed production install" }
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val captured = AtomicInteger()
        val incorrectMeter = AtomicInteger()
        val failures = AtomicInteger()
        val drained = CountDownLatch(1)
        lateinit var call: CallService
        call = CallService(context, "visual-test", { pcm ->
            val expected = AudioVisualLevels.level(AudioVisualLevels.power(pcm), pcm.size / 2)
            if (abs(call.microphoneLevel(SystemClock.elapsedRealtime()) - expected) > .0001f) incorrectMeter.incrementAndGet()
            captured.incrementAndGet()
        }, { if (it == "done") drained.countDown() }, { failures.incrementAndGet(); drained.countDown() })
        lateinit var screen: CallScreen
        val preferences = ScreenPreferences(context)
        val previousAnimations = preferences.animations
        preferences.animations = true
        var screenCreated = false
        try {
            instrumentation.runOnMainSync {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                screen = CallScreen(activity, call, { call.setSpeakerEnabled(it) }, { call.close() })
                screenCreated = true
                activity.setContentView(screen)
                screen.resume()
                call.start()
            }
            await(2000) { texts(screen).contains("Connecting audio…") }
            assertEquals("No synthetic level while connecting", 0f, screen.energy(0f, 0), 0f)
            for (frame in 0 until 60) {
                val pcm = ByteArray(960)
                for (sample in 0 until 480) {
                    val value = (4000 * sin(2 * Math.PI * 440 * (frame * 480 + sample) / 24000)).toInt()
                    pcm[sample * 2] = value.toByte()
                    pcm[sample * 2 + 1] = (value shr 8).toByte()
                }
                call.receive(pcm)
            }
            call.mark("done")
            await(5000) { texts(screen).contains("Speaking…") && screen.energy(0f, 2) > .05f }
            instrumentation.runOnMainSync {
                val renderer = screen.getChildAt(0)
                screen.captions("A test request", true, "A test reply", false)
                assertSame("Caption update recreated the renderer", renderer, screen.getChildAt(0))
                assertTrue(texts(screen).contains("You: A test request"))
                assertFalse(texts(screen).any { it.contains("fps", true) || it.contains("native lens", true) ||
                    it.contains("R A D I A N C E") || it.contains("Animate voice") })
                assertTrue(texts(screen).contains("Assistant (live): A test reply"))
                assertEquals(android.provider.Settings.Secure.getInt(context.contentResolver, "window_ignore_secure", 0) == 0,
                    activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            }
            instrumentation.runOnMainSync {
                screen.captions("Long caption ".repeat(600), true, "Long reply ".repeat(600), true)
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val hangup = descendants(screen).filterIsInstance<Button>().single { it.text.toString() == "Hang up" }
                val visible = android.graphics.Rect()
                val position = IntArray(2)
                hangup.getLocationOnScreen(position)
                assertTrue("Hang up hidden: focus=${activity.hasWindowFocus()}, y=${position[1]}, " +
                    "height=${hangup.height}, screen=${screen.height}, panel=${(hangup.parent.parent as View).height}",
                    hangup.getGlobalVisibleRect(visible))
                assertEquals("Hang up was clipped by captions", hangup.height, visible.height())
            }
            assertTrue("Playback did not reach the hardware fence", drained.await(8, TimeUnit.SECONDS))
            assertEquals("Audio pipeline failed", 0, failures.get())
            assertTrue("Real microphone frames were not captured", captured.get() > 0)
            assertEquals("Microphone levels did not match captured PCM", 0, incorrectMeter.get())
            await(3000) { texts(screen).contains("Listening…") }
            instrumentation.runOnMainSync {
                preferences.animations = false
                screen.refreshAppearance()
                screen.captions("Still listening", true, "Motion is off", true)
            }
            await(2000) { screen.energy(0f, 1) == 0f && texts(screen).contains("You: Still listening") }
            instrumentation.runOnMainSync {
                screen.pause()
                screen.resume()
                call.close()
            }
            await(2000) { texts(screen).contains("Call ended") && screen.energy(0f, 4) == 0f }
            assertEquals(0f, call.microphoneLevel(SystemClock.elapsedRealtime()), 0f)
            assertEquals(0f, call.playbackLevel(), 0f)
        } finally {
            instrumentation.runOnMainSync { call.close(); if (screenCreated) screen.dispose(); activity.finish() }
            preferences.animations = previousAnimations
        }
    }

    @Test fun productionActivityRetainsRadianceFromHomeThroughCallAndHangup() {
        check(BuildConfig.ISOLATED_INTEGRATION)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val app = context.applicationContext as Gateway
        val call = CallService(context, "ui-session-fixture", {}, {}, {})
        val callField = Gateway::class.java.getDeclaredField("call").apply { isAccessible = true }
        val verifiedField = Gateway::class.java.getDeclaredField("verifiedInbox").apply { isAccessible = true }
        // Test-only session injection: no pairing credentials, transport or production inbox.
        val activity = instrumentation.startActivitySync(Intent(context, InboxActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as InboxActivity
        val previousSpeaker = app.speakerEnabled
        lateinit var screen: CallScreen
        lateinit var renderer: View
        try {
            await(3000) { descendants(activity.window.decorView).any { it is CallScreen } }
            instrumentation.runOnMainSync {
                screen = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
                renderer = screen.getChildAt(0)
                check(app.callId == null)
                app.store.state.pending[call.id] = Pending(call.id, "Fixture", "Choose the fixture option", 1L)
                app.store.state.proposals[call.id] = "Fixture proposal"
                app.store.state.details[call.id] = QuestionDisplay(1, "Long request context ".repeat(300), listOf(
                    DisplayField("f0", "Choose several", "multi", true, options = listOf(
                        DisplayOption("o0", "Duplicate choice", false), DisplayOption("o1", "Duplicate choice", true))),
                    DisplayField("f1", "Explain your answer", "text", false, placeholder = "Your explanation")
                ))
                verifiedField.setBoolean(app, true)
                callField.set(app, call)
                app.setSpeakerEnabled(!previousSpeaker)
                assertSame(screen, descendants(activity.window.decorView).filterIsInstance<CallScreen>().single())
                assertSame(renderer, screen.getChildAt(0))
                assertEquals(ScreenPreferences(context).blockScreenshots &&
                    android.provider.Settings.Secure.getInt(context.contentResolver, "window_ignore_secure", 0) == 0,
                    activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val details = descendants(screen).filterIsInstance<Button>().singleOrNull { it.text.toString() == "Details" }
                assertNotNull("Active calls must retain access to fixed question details", details)
                details!!.performClick()
                assertTrue(texts(activity.window.decorView).contains("Choose the fixture option"))
                assertTrue(texts(activity.window.decorView).contains("Fixture proposal"))
                assertTrue(descendants(activity.window.decorView).any { it is QuestionDetailView })
                assertTrue("Opening details stopped voice", call.active)
                val options = descendants(activity.window.decorView).filterIsInstance<TextView>()
                    .filter { it.tag == "${call.id}/f0/o0" || it.tag == "${call.id}/f0/o1" }
                assertEquals(2, options.size)
                assertTrue(options.all { !it.isClickable })
                assertTrue(texts(activity.window.decorView).any { it.contains("Unavailable") })
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTrue("Long request cannot scroll", descendants(activity.window.decorView)
                    .filterIsInstance<android.widget.ScrollView>().any { it.isShown && it.canScrollVertically(1) })
                for (label in listOf("Back", "Hang up")) {
                    val action = descendants(activity.window.decorView).filterIsInstance<Button>()
                        .single { it.isShown && it.text.toString() == label }
                    val visible = android.graphics.Rect()
                    assertTrue(action.getGlobalVisibleRect(visible))
                    assertEquals("Long request clipped $label", action.height, visible.height())
                }
                descendants(activity.window.decorView).filterIsInstance<Button>()
                    .single { it.text.toString() == "Back" }.performClick()
                assertSame(renderer, screen.getChildAt(0))
                descendants(screen).filterIsInstance<Button>().single { it.text.toString() == "Hang up" }.performClick()
                assertNull(app.callVisual)
                assertFalse(call.active)
            }
            await(3000) { texts(screen).contains("Your desktop, in reach.") }
            instrumentation.runOnMainSync {
                assertSame(screen, descendants(activity.window.decorView).filterIsInstance<CallScreen>().single())
                assertSame(renderer, screen.getChildAt(0))
                assertEquals(0f, screen.energy(0f, 1), 0f)
            }
        } finally {
            instrumentation.runOnMainSync {
                app.hangup(); call.close(); app.setSpeakerEnabled(previousSpeaker); activity.finish()
                app.store.state.pending.remove(call.id)
                app.store.state.proposals.remove(call.id)
                app.store.state.details.remove(call.id)
                verifiedField.setBoolean(app, false)
            }
        }
    }

    private fun await(timeout: Long, predicate: () -> Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (SystemClock.elapsedRealtime() < deadline) {
            var ready = false
            instrumentation.runOnMainSync { ready = predicate() }
            if (ready) return
            SystemClock.sleep(20)
        }
        fail("Timed out waiting for integrated audio/UI state")
    }

    private fun descendants(view: View): List<View> {
        val result = mutableListOf(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) result.addAll(descendants(view.getChildAt(index)))
        return result
    }
    private fun texts(view: View) = descendants(view).filterIsInstance<TextView>().map { it.text.toString() }
}
