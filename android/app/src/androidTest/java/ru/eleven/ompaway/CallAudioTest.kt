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
import android.graphics.Bitmap
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import java.io.File
import org.json.JSONObject
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
        val arguments = InstrumentationRegistry.getArguments()
        val port = arguments.getString("desktopAudioPort")?.toIntOrNull()
        assumeTrue("Requires the isolated desktop voice probe over adb reverse", port != null && port in 1024..65535)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(context.packageName == "ru.eleven.ompaway.integration") { "Disposable integration app only" }
        val showCallScreen = arguments.getString("callScreen") == "on"
        val snapshotRun = arguments.getString("callScreenSnapshots")
        require(snapshotRun == null || showCallScreen && snapshotRun.matches(Regex("[a-z0-9-]{1,64}")))
        if (!showCallScreen) configureSpeaker()
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        var screen: CallScreen? = null
        var visualProbe: LiveScreenProbe? = null
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
            val microphoneFrames = AtomicInteger()
            val receivedFrames = AtomicInteger()
            fun renderVoice() {
                val actual = screen
                if (actual != null) actual.captions(callerText, callerFinal, assistantText, assistantFinal)
                else if (!showCallScreen) transcriptViews.update(mediaReady, mediaSpeaking, callerText, callerFinal, assistantText, assistantFinal)
            }
            instrumentation.runOnMainSync {
                if (showCallScreen) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else {
                    val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                    val status = TextView(activity)
                    callerView = TextView(activity)
                    val assistant = TextView(activity)
                    column.addView(status); column.addView(callerView); column.addView(assistant)
                    activity.setContentView(column)
                    transcriptViews = CallTranscriptViews(status, callerView, assistant)
                    renderVoice()
                }
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
                val call = CallService(context, "isolated-test", { microphoneFrames.incrementAndGet(); send(1, it) },
                    { played.incrementAndGet(); send(2) }, {
                        failures.incrementAndGet()
                        // The desktop may already have closed the transport after a failed scenario.
                        // Keep the original failure observable without crashing before evidence cleanup.
                        try { send(3) } catch (_: java.io.IOException) { }
                    },
                    { instrumentation.runOnMainSync { mediaReady = true; renderVoice() } },
                    { active -> instrumentation.runOnMainSync {
                        mediaSpeaking = active
                        if (active) speakingTransitions.incrementAndGet() else listeningTransitions.incrementAndGet()
                        renderVoice()
                    } })
                try {
                    instrumentation.runOnMainSync {
                        if (showCallScreen) {
                            val speakerMode = arguments.getString("speakerMode")
                            require(speakerMode == null || speakerMode == "on" || speakerMode == "off")
                            val enabled = speakerMode?.let { it == "on" } ?: CallAudioSettings(context).speakerEnabled
                            check(call.setSpeakerEnabled(enabled))
                            screen = CallScreen(activity, call, { next ->
                                if (call.setSpeakerEnabled(next)) screen?.setSpeaker(next)
                            }, { call.close(); socket.close() }).also {
                                activity.setContentView(it); it.setSpeaker(enabled); it.resume()
                            }
                            renderVoice()
                        }
                        call.start()
                    }
                    if (showCallScreen) {
                        visualProbe = LiveScreenProbe(activity, checkNotNull(screen), call, microphoneFrames, receivedFrames,
                            snapshotRun?.let { File(context.filesDir, "acoustic-screen/$it") }) {
                            callerFinal && assistantFinal && callerFinals.get() >= 2 &&
                                callerText.isNotBlank() && assistantText.isNotBlank() &&
                                containsText(checkNotNull(screen), "You: $callerText") &&
                                containsText(checkNotNull(screen), "Assistant: $assistantText")
                        }.also { it.start() }
                    }
                    while (true) when (input.readUnsignedByte()) {
                        1 -> {
                            val pcm = ByteArray(960).also { input.readFully(it) }
                            receivedFrames.incrementAndGet(); call.receive(pcm)
                        }
                        2 -> call.mark("drain")
                        3 -> { visualProbe?.finishCaptions(); break }
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
                    val expectedSpeaker = if (showCallScreen) arguments.getString("speakerMode")?.let { it == "on" }
                        ?: CallAudioSettings(context).speakerEnabled else CallAudioSettings(context).speakerEnabled
                    if (expectedSpeaker) awaitSpeaker(context.getSystemService(AudioManager::class.java), true)
                    assertEquals("Opening and options did not physically drain", 2, played.get())
                    if (InstrumentationRegistry.getArguments().getString("captions") == "on") {
                        assertTrue("Live transcript snapshots never arrived", partialCaptions.get() > 0)
                        assertTrue("Both caller turns must complete", callerFinals.get() >= 2)
                        instrumentation.runOnMainSync {
                            assertTrue("The confirmation caption must be final", callerFinal)
                            assertTrue("The recognized confirmation must not be empty", callerText.isNotBlank())
                            if (showCallScreen) assertTrue("CallScreen must show the actual recognized caption",
                                containsText(checkNotNull(screen), "You: $callerText"))
                            else assertEquals("The caption view must show the actual recognized confirmation",
                                "You: $callerText", callerView.text.toString())
                        }
                    }
                    assertTrue("Speaking phase never started", speakingTransitions.get() > 0)
                    assertTrue("Speaking phase did not return to listening after hardware playout", listeningTransitions.get() > 0)
                    visualProbe?.assertAudioDrivenWaves()
                } finally {
                    try { visualProbe?.close() }
                    finally { instrumentation.runOnMainSync { screen?.dispose(); call.close() } }
                }
            }
        } finally {
            instrumentation.runOnMainSync {
                screen?.dispose()
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                activity.finish()
            }
        }
    }
    private fun containsText(view: View, text: String): Boolean =
        view.isShown && ((view is TextView && view.text.toString() == text) ||
            (view is ViewGroup && (0 until view.childCount).any { containsText(view.getChildAt(it), text) }))

    private data class LiveScreenSample(val phase: String?, val mic: Float, val playback: Float, val energy: Float, val bounds: Rect)

    /** Observes production rendering and real CallService levels; never supplies synthetic energy/state. */
    private inner class LiveScreenProbe(
        private val activity: Activity, private val screen: CallScreen, private val call: CallService,
        private val microphoneFrames: AtomicInteger, private val receivedFrames: AtomicInteger,
        private val directory: File?, private val finalCaptions: () -> Boolean,
    ) : AutoCloseable {
        private val instrumentation = InstrumentationRegistry.getInstrumentation()
        private val running = AtomicBoolean(true)
        private val finishing = AtomicBoolean()
        private val finalObserved = CountDownLatch(1)
        private val draws = AtomicInteger()
        private val seen = mutableMapOf<String, Int>()
        private val captured = mutableMapOf<String, Int>()
        private val observations = org.json.JSONArray()
        private val errors = mutableListOf<String>()
        private val drawListener = android.view.ViewTreeObserver.OnDrawListener { draws.incrementAndGet() }
        private var lastCapture = 0L
        private val worker = Thread({
            try {
                while (running.get()) {
                    observe()
                    Thread.sleep(80)
                }
            } catch (_: InterruptedException) { /* Normal teardown. */ }
            catch (error: Exception) { synchronized(errors) { errors.add(error.javaClass.simpleName) } }
        }, "away-live-screen-observer")

        fun start() {
            directory?.let { check(it.mkdirs()) { "Snapshot directory already exists or cannot be created" } }
            instrumentation.runOnMainSync { screen.viewTreeObserver.addOnDrawListener(drawListener) }
            worker.start()
        }

        private fun sample(): LiveScreenSample {
            var result = LiveScreenSample(null, 0f, 0f, 0f, Rect())
            instrumentation.runOnMainSync {
                val now = SystemClock.elapsedRealtime()
                val mic = call.microphoneLevel(now)
                val playback = call.playbackLevel()
                val energy = screen.energy(0f, 0)
                val location = IntArray(2)
                screen.getLocationOnScreen(location)
                val bounds = Rect(location[0], location[1], location[0] + screen.width, location[1] + screen.height)
                val visible = screen.isAttachedToWindow && screen.isShown && activity.hasWindowFocus() &&
                    !bounds.isEmpty && draws.get() >= 2 && call.active
                val phase = if (!visible) null
                    else if (finishing.get() && microphoneFrames.get() > 0 && receivedFrames.get() > 0 && finalCaptions()) "final-captions"
                    else if (!call.connected && containsText(screen, "Connecting audio…")) "connecting"
                    else if (call.connected && receivedFrames.get() > 0 && playback > 0f && energy > 0f &&
                        containsText(screen, "Speaking…")) "speaking"
                    else if (call.connected && microphoneFrames.get() > 0 && mic > 0f && energy > 0f &&
                        containsText(screen, "Listening…")) "listening"
                    else null
                result = LiveScreenSample(phase, mic, playback, energy, bounds)
            }
            return result
        }

        private fun observe() {
            val before = sample()
            val phase = before.phase ?: return
            synchronized(seen) { seen[phase] = (seen[phase] ?: 0) + 1 }
            if (directory == null) {
                if (phase == "final-captions") finalObserved.countDown()
                return
            }
            val count = captured[phase] ?: 0
            val wanted = if (phase == "listening" || phase == "speaking") 2 else 1
            if (count >= wanted || SystemClock.elapsedRealtime() - lastCapture < 180) return
            val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
            try {
                val after = sample()
                if (after.phase != phase || after.bounds != before.bounds) return
                val bounds = before.bounds
                if (bounds.left < 0 || bounds.top < 0 || bounds.right > bitmap.width || bounds.bottom > bitmap.height) return
                val cropped = Bitmap.createBitmap(bitmap, bounds.left, bounds.top, bounds.width(), bounds.height())
                val name = "$phase-${count + 1}.png"
                try { File(directory, name).outputStream().use { check(cropped.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
                finally { if (cropped !== bitmap) cropped.recycle() }
                captured[phase] = count + 1
                lastCapture = SystemClock.elapsedRealtime()
                observations.put(JSONObject().put("file", name).put("phase", phase).put("elapsedMillis", lastCapture)
                    .put("microphoneFrames", microphoneFrames.get()).put("receivedFrames", receivedFrames.get())
                    .put("draws", draws.get()).put("microphoneLevel", before.mic.toDouble())
                    .put("playbackLevel", before.playback.toDouble()).put("renderedEnergy", before.energy.toDouble()))
                if (phase == "final-captions") finalObserved.countDown()
            } finally { bitmap.recycle() }
        }

        fun finishCaptions() {
            finishing.set(true)
            finalObserved.await(3, TimeUnit.SECONDS)
        }

        fun assertAudioDrivenWaves() {
            synchronized(errors) { assertTrue("Live screen observer failed: $errors", errors.isEmpty()) }
            synchronized(seen) {
                assertTrue("CallScreen never rendered listening waves from real microphone frames", (seen["listening"] ?: 0) > 0)
                assertTrue("CallScreen never rendered speaking waves from real hardware playback", (seen["speaking"] ?: 0) > 0)
                assertTrue("CallScreen never displayed final real captions", (seen["final-captions"] ?: 0) > 0)
            }
        }

        override fun close() {
            running.set(false); worker.interrupt(); worker.join(5000)
            check(!worker.isAlive) { "Live screen observer did not stop" }
            instrumentation.runOnMainSync {
                if (screen.viewTreeObserver.isAlive) screen.viewTreeObserver.removeOnDrawListener(drawListener)
            }
            directory?.let {
                val states = JSONObject()
                for (phase in listOf("connecting", "listening", "speaking", "final-captions")) {
                    states.put(phase, JSONObject().put("observed", (seen[phase] ?: 0) > 0)
                        .put("captured", captured[phase] ?: 0)
                        .put("status", if ((captured[phase] ?: 0) > 0) "captured" else if ((seen[phase] ?: 0) > 0) "observed-not-captured" else "unobserved"))
                }
                File(it, "manifest.json").writeText(JSONObject().put("source", "production-CallScreen-real-CallService")
                    .put("states", states).put("snapshots", observations).put("errors", org.json.JSONArray(errors)).toString(2))
            }
        }
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
