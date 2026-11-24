package ru.eleven.ompaway

import android.Manifest
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.app.Activity
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.io.DataInputStream
import java.net.InetAddress
import java.net.Socket
import org.junit.Assume.assumeTrue
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.sin
import android.widget.LinearLayout
import android.widget.TextView
import ru.eleven.ompaway.security.bytesJson

class CallAudioTest {
    @Test fun permissionRevokedBeforeRecorderAllocationNeverStartsAudio() {
        checkMicrophoneRevocation(atAllocation = true)
    }

    @Test fun permissionRevokedDuringCaptureStopsSendingAudio() {
        checkMicrophoneRevocation(atAllocation = false)
    }

    private fun checkMicrophoneRevocation(atAllocation: Boolean) {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val base = instrument.targetContext
        assumeTrue(base.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        val checks = AtomicInteger()
        val revoked = AtomicBoolean()
        val context = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun checkSelfPermission(permission: String): Int {
                if (permission != Manifest.permission.RECORD_AUDIO) return super.checkSelfPermission(permission)
                val check = checks.incrementAndGet()
                return if ((atAllocation && check > 1) || revoked.get()) PackageManager.PERMISSION_DENIED
                    else PackageManager.PERMISSION_GRANTED
            }
        }
        val activity = instrument.startActivitySync(Intent(base, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val failed = CountDownLatch(1)
        val firstFrame = CountDownLatch(1)
        val frames = AtomicInteger()
        val failures = AtomicInteger()
        val ready = AtomicInteger()
        val call = CallService(context, "permission-revocation", {
            frames.incrementAndGet(); firstFrame.countDown()
        }, {}, { failures.incrementAndGet(); failed.countDown() }, { ready.incrementAndGet() })
        try {
            instrument.runOnMainSync { call.start() }
            call.receive(ByteArray(960))
            if (!atAllocation) {
                assertTrue("Capture never reached the revocation point", firstFrame.await(5, TimeUnit.SECONDS))
                revoked.set(true)
            }
            assertTrue("Revoked microphone permission did not terminate audio", failed.await(5, TimeUnit.SECONDS))
            assertTrue("Allocation-boundary permission was not checked", checks.get() >= 2)
            assertEquals(1, failures.get())
            if (atAllocation) {
                assertEquals(0, frames.get())
                assertEquals(0, ready.get())
            }
            val stoppedAt = frames.get()
            call.receive(ByteArray(960))
            SystemClock.sleep(250)
            assertEquals("Audio continued after permission failure", stoppedAt, frames.get())
        } finally { instrument.runOnMainSync { call.close(); activity.finish() } }
    }

    @Test fun speakerPreferenceRoutesNewCallsAndDoesNotLeakIntoTheNextCall() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val preferences = context.getSharedPreferences("away.audio.v1", android.content.Context.MODE_PRIVATE)
        val previous = preferences.getBoolean("speaker", false)
        val audio = context.getSystemService(AudioManager::class.java)
        val previousMode = audio.mode
        val failures = AtomicInteger()
        var call: CallService? = null
        try {
            // "Off" releases the app override. Android may still choose the speaker,
            // particularly on devices with no earpiece; capture policy rather than invent it.
            if (Build.VERSION.SDK_INT >= 31) instrumentation.runOnMainSync { audio.clearCommunicationDevice() }
            var normalDeviceId: Int? = null
            for (speaker in listOf(false, true, false)) {
                check(preferences.edit().putBoolean("speaker", speaker).commit())
                val next = CallService(context, "route-test", {}, {}, { failures.incrementAndGet() })
                call = next
                instrumentation.runOnMainSync { next.start() }
                if (Build.VERSION.SDK_INT >= 31 && normalDeviceId == null) normalDeviceId = stableNormalDevice(audio)
                awaitSpeaker(audio, speaker, normalDeviceId)
                if (speaker) {
                    instrumentation.runOnMainSync { assertTrue(next.setSpeakerEnabled(false)) }
                    awaitSpeaker(audio, false, normalDeviceId)
                    instrumentation.runOnMainSync { assertTrue(next.setSpeakerEnabled(true)) }
                    awaitSpeaker(audio, true)
                }
                instrumentation.runOnMainSync { next.close() }
                assertEquals("Call audio mode leaked after hangup", previousMode, audio.mode)
            }
            assertEquals("Audio routing failed", 0, failures.get())
        } finally {
            instrumentation.runOnMainSync { call?.close(); activity.finish() }
            check(preferences.edit().putBoolean("speaker", previous).commit())
        }
    }
    @Test fun isolatedDesktopSpeechReachesHardwareWithMicrophoneRunning() {
        val port = InstrumentationRegistry.getArguments().getString("desktopAudioPort")?.toIntOrNull()
        assumeTrue("Requires the isolated desktop voice probe over adb reverse", port != null && port in 1024..65535)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        configureSpeaker()
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            lateinit var transcriptViews: CallTranscriptViews
            lateinit var callerView: TextView
            var mediaReady = false
            var mediaSpeaking = false
            var callerText = ""
            var assistantText = ""
            var callerFinal = false
            var assistantFinal = false
            val partialCaptions = AtomicInteger()
            val callerFinals = AtomicInteger()
            val speakingTransitions = AtomicInteger()
            val listeningTransitions = AtomicInteger()
            fun renderVoice() = transcriptViews.update(mediaReady, mediaSpeaking, callerText, callerFinal, assistantText, assistantFinal)
            instrumentation.runOnMainSync {
                val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                val status = TextView(activity)
                callerView = TextView(activity)
                val assistant = TextView(activity)
                column.addView(status); column.addView(callerView); column.addView(assistant)
                activity.setContentView(column)
                transcriptViews = CallTranscriptViews(status, callerView, assistant)
                renderVoice()
            }
            Socket(InetAddress.getLoopbackAddress(), port!!).use { socket ->
                socket.soTimeout = 120_000
                val input = DataInputStream(socket.getInputStream())
                val output = socket.getOutputStream()
                val failures = AtomicInteger()
                val played = AtomicInteger()
                var activeRequest: String? = null
                fun send(kind: Int, pcm: ByteArray? = null) = synchronized(output) {
                    output.write(kind); if (pcm != null) output.write(pcm); output.flush()
                }
                val call = CallService(context, "isolated-test", { send(1, it) },
                    { played.incrementAndGet(); send(2) }, { failures.incrementAndGet(); send(3) },
                    { instrumentation.runOnMainSync { mediaReady = true; renderVoice() } },
                    { active -> instrumentation.runOnMainSync {
                        mediaSpeaking = active
                        if (active) speakingTransitions.incrementAndGet() else listeningTransitions.incrementAndGet()
                        renderVoice()
                    } })
                try {
                    instrumentation.runOnMainSync { call.start() }
                    while (true) when (input.readUnsignedByte()) {
                        1 -> call.receive(ByteArray(960).also { input.readFully(it) })
                        2 -> call.mark("drain")
                        3 -> break
                        4 -> {
                            val size = input.readInt()
                            require(size in 1..65536)
                            val message = bytesJson(ByteArray(size).also { input.readFully(it) })
                            if (message.getString("type") == "joined") activeRequest = message.getString("requestId")
                            else {
                                check(message.getString("type") == "transcript" && message.getString("requestId") == activeRequest)
                                val role = message.getString("role")
                                val text = message.getString("text")
                                val final = message.get("final") as Boolean
                                require((role == "user" || role == "assistant") && text.length <= 8192)
                                if (!final) partialCaptions.incrementAndGet()
                                if (final && role == "user") callerFinals.incrementAndGet()
                                instrumentation.runOnMainSync {
                                    if (role == "user") { callerText = text; callerFinal = final }
                                    else { assistantText = text; assistantFinal = final }
                                    renderVoice()
                                }
                            }
                        }
                        else -> error("Invalid isolated audio packet")
                    }
                    assertEquals("Real audio failed", 0, failures.get())
                    if (CallAudioSettings(context).speakerEnabled) awaitSpeaker(context.getSystemService(AudioManager::class.java), true)
                    assertEquals("Opening and options did not physically drain", 2, played.get())
                    if (InstrumentationRegistry.getArguments().getString("captions") == "on") {
                        assertTrue("Live transcript snapshots never arrived", partialCaptions.get() > 0)
                        assertTrue("Both caller turns must complete", callerFinals.get() >= 2)
                        instrumentation.runOnMainSync {
                            assertTrue("The confirmation caption must be final", callerFinal)
                            assertTrue("The recognized confirmation must not be empty", callerText.isNotBlank())
                            assertEquals("The caption view must show the actual recognized confirmation",
                                "You: $callerText", callerView.text.toString())
                        }
                    }
                    assertTrue("Speaking phase never started", speakingTransitions.get() > 0)
                    assertTrue("Speaking phase did not return to listening after hardware playout", listeningTransitions.get() > 0)
                } finally { instrumentation.runOnMainSync { call.close() } }
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
    @Test fun joinedAudioCapturesAndReachesHardwareWithoutOpeningThePairedInbox() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        configureSpeaker()
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val audio = context.getSystemService(AudioManager::class.java)
        val captured = CountDownLatch(1)
        val drained = CountDownLatch(1)
        val failures = AtomicInteger()
        val loud = AtomicInteger()
        val frames = AtomicInteger()
        val microphone = CountDownLatch(1)
        val ready = AtomicInteger()
        val captureAtReady = AtomicInteger(-1)
        val call = CallService(context, "audio-test", { pcm ->
            microphone.countDown()
            var energy = 0.0
            for (i in pcm.indices step 2) {
                val sample = ((pcm[i].toInt() and 255) or (pcm[i + 1].toInt() shl 8)).toShort().toInt()
                energy += sample.toDouble() * sample
            }
            if (energy / 480 >= 800.0 * 800) loud.incrementAndGet()
            if (frames.incrementAndGet() >= 50) captured.countDown()
        }, { if (it == "drain") drained.countDown() }, { failures.incrementAndGet(); drained.countDown() }, {
            captureAtReady.set(frames.get()); ready.incrementAndGet()
        })
        try {
            instrumentation.runOnMainSync { call.start() }
            // Real AudioRecord startup is asynchronous; test against its first callback.
            assertFalse("Microphone started before any desktop audio", microphone.await(1, TimeUnit.SECONDS))
            assertEquals("Call became ready before any desktop audio", 0, ready.get())
            // This tone tests AudioTrack, not model speech or confirmation authority.
            for (frame in 0 until 50) {
                val pcm = ByteArray(960)
                for (sample in 0 until 480) {
                    val value = (3000 * sin(2 * Math.PI * 440 * (frame * 480 + sample) / 24000)).toInt()
                    pcm[sample * 2] = value.toByte(); pcm[sample * 2 + 1] = (value shr 8).toByte()
                }
                call.receive(pcm)
            }
            call.mark("drain")
            assertTrue("Microphone did not start with playback", captured.await(5, TimeUnit.SECONDS))
            assertTrue("Output never reached a physical presentation timestamp", drained.await(8, TimeUnit.SECONDS))
            assertEquals("Audio lifecycle failed", 0, failures.get())
            assertEquals("Playback must make the call ready exactly once", 1, ready.get())
            if (CallAudioSettings(context).speakerEnabled) awaitSpeaker(audio, true)
            assertTrue("Playback started before the microphone route was ready", captureAtReady.get() > 0)
            val status = android.os.Bundle().apply {
                putInt("captureFrames", frames.get()); putInt("hotMicFrames", loud.get())
                putInt("communicationDeviceType", if (Build.VERSION.SDK_INT >= 31) audio.communicationDevice?.type ?: -1 else -1)
                putInt("callVolume", audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
            }
            instrumentation.sendStatus(0, status)
        } finally { instrumentation.runOnMainSync { call.close(); activity.finish() } }
    }
    private fun configureSpeaker() {
        val mode = InstrumentationRegistry.getArguments().getString("speakerMode") ?: return
        require(mode == "on" || mode == "off") { "speakerMode must be on or off" }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as Gateway
        instrumentation.runOnMainSync { app.setSpeakerEnabled(mode == "on") }
    }

    @Suppress("DEPRECATION")
    private fun awaitSpeaker(audio: AudioManager, enabled: Boolean, normalDeviceId: Int? = null) {
        val deadline = SystemClock.elapsedRealtime() + 3000
        if (Build.VERSION.SDK_INT >= 31) {
            val expected = if (enabled) audio.availableCommunicationDevices.first { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }.id
                else requireNotNull(normalDeviceId) { "Capture Android's normal route before asserting speaker off" }
            while (audio.communicationDevice?.id != expected && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20)
            assertTrue("Expected route disappeared", audio.availableCommunicationDevices.any { it.id == expected })
            assertEquals("Wrong communication output device", expected, audio.communicationDevice?.id)
        } else {
            while (audio.isSpeakerphoneOn != enabled && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20)
            assertEquals("Wrong legacy speaker override", enabled, audio.isSpeakerphoneOn)
        }
    }

    @android.annotation.TargetApi(31)
    private fun stableNormalDevice(audio: AudioManager): Int {
        val deadline = SystemClock.elapsedRealtime() + 3000
        var candidate: Int? = null
        var stableSince = SystemClock.elapsedRealtime()
        while (SystemClock.elapsedRealtime() < deadline) {
            val current = audio.communicationDevice?.id
            val available = current != null && audio.availableCommunicationDevices.any { it.id == current }
            if (!available || candidate != current) {
                candidate = if (available) current else null
                stableSince = SystemClock.elapsedRealtime()
            } else if (candidate != null && SystemClock.elapsedRealtime() - stableSince >= 200) return candidate
            SystemClock.sleep(20)
        }
        throw AssertionError("Android did not select a stable available communication device")
    }
}
