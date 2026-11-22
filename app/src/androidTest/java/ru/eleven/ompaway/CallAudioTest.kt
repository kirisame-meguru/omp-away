package ru.eleven.ompaway

import android.app.Activity
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.io.DataInputStream
import java.net.InetAddress
import java.net.Socket
import org.junit.Assume.assumeTrue
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.sin

class CallAudioTest {
    @Test fun isolatedDesktopSpeechReachesHardwareWithMicrophoneRunning() {
        val port = InstrumentationRegistry.getArguments().getString("desktopAudioPort")?.toIntOrNull()
        assumeTrue("Requires the isolated desktop voice probe over adb reverse", port != null && port in 1024..65535)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            Socket(InetAddress.getLoopbackAddress(), port!!).use { socket ->
                socket.soTimeout = 120_000
                val input = DataInputStream(socket.getInputStream())
                val output = socket.getOutputStream()
                val failures = AtomicInteger()
                val played = AtomicInteger()
                fun send(kind: Int, pcm: ByteArray? = null) = synchronized(output) {
                    output.write(kind); if (pcm != null) output.write(pcm); output.flush()
                }
                val call = CallService(context, "isolated-test", { send(1, it) },
                    { played.incrementAndGet(); send(2) }, { failures.incrementAndGet(); send(3) })
                try {
                    instrumentation.runOnMainSync { call.start() }
                    while (true) when (input.readUnsignedByte()) {
                        1 -> call.receive(ByteArray(960).also { input.readFully(it) })
                        2 -> call.mark("drain")
                        3 -> break
                        else -> error("Invalid isolated audio packet")
                    }
                    assertEquals("Real audio failed", 0, failures.get())
                    assertEquals("Opening and options did not physically drain", 2, played.get())
                } finally { instrumentation.runOnMainSync { call.close() } }
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
    @Test fun joinedAudioCapturesAndReachesHardwareWithoutOpeningThePairedInbox() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
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
            assertTrue("Playback started before the microphone route was ready", captureAtReady.get() > 0)
            val status = android.os.Bundle().apply {
                putInt("captureFrames", frames.get()); putInt("hotMicFrames", loud.get())
                putInt("communicationDeviceType", if (Build.VERSION.SDK_INT >= 31) audio.communicationDevice?.type ?: -1 else -1)
                putInt("callVolume", audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
            }
            instrumentation.sendStatus(0, status)
        } finally { instrumentation.runOnMainSync { call.close(); activity.finish() } }
    }
}
