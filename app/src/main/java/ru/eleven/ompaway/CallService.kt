package ru.eleven.ompaway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal fun presented(target: Long, position: Long, presentationNs: Long, nowNs: Long) =
    position >= target && presentationNs > 0 && presentationNs <= nowNs

/** Activity-owned call, deliberately NOT an Android background/foreground service. */
internal class CallService(
    context: Context, val id: String,
    private val send: (ByteArray) -> Unit,
    private val played: (String) -> Unit,
    private val failed: () -> Unit,
    private val ready: () -> Unit = {},
) : AutoCloseable {
    private val app = context.applicationContext
    private val audio = checkNotNull(app.getSystemService(AudioManager::class.java))
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes).setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener({ change -> if (change < 0) fail() }, Handler(Looper.getMainLooper())).build()
    private val queue = ArrayBlockingQueue<Any>(64) // 1.28 seconds; never acknowledge discarded audio
    private val gate = Any()
    private val live = AtomicBoolean(true)
    private val captureReady = CountDownLatch(1)
    private var recording: AudioRecord? = null
    private var output: AudioTrack? = null
    private var ownsFocus = false
    private var previousMode: Int? = null
    private var started = false

    // Serial channel reader owns each PCM array; do not copy or return it to a pool.
    fun receive(pcm: ByteArray) { if (live.get() && (pcm.size != BYTES || !queue.offer(pcm))) fail() }
    fun mark(mark: String) { if (live.get() && !queue.offer(mark)) fail() }

    fun invalidate() { live.set(false); captureReady.countDown() }

    fun start() {
        if (started || !live.get()) return
        started = true
        if (app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ||
            audio.mode == AudioManager.MODE_IN_CALL || audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            fail(); return
        }
        ownsFocus = true
        try {
            previousMode = audio.mode
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            worker("Away playout", ::playback)
        } catch (_: RuntimeException) { fail() }
    }

    private fun worker(name: String, body: () -> Unit) = Thread({
        try { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO); body() }
        catch (_: Exception) { if (live.get()) fail() }
    }, name).start()

    private fun fail() {
        if (live.getAndSet(false)) { captureReady.countDown(); failed() }
    }

    private fun capture() {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(min > 0)
        val record = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(format(AudioFormat.CHANNEL_IN_MONO)).setBufferSizeInBytes(maxOf(min, BYTES * 4)).build()
        var echo: AcousticEchoCanceler? = null
        try {
            check(record.state == AudioRecord.STATE_INITIALIZED)
            if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(record.audioSessionId)?.also { it.setEnabled(true) }
            synchronized(gate) {
                if (!live.get()) return
                recording = record
                record.startRecording()
            }
            check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING)
            val buffer = ByteArray(BYTES)
            var offset = 0
            var nextPrivacyCheck = 0L
            var first = true
            while (live.get()) {
                val now = SystemClock.elapsedRealtime()
                if (now >= nextPrivacyCheck) {
                    check(record.activeRecordingConfiguration?.isClientSilenced != true && audio.mode != AudioManager.MODE_IN_CALL)
                    nextPrivacyCheck = now + 200
                }
                val n = record.read(buffer, offset, BYTES - offset, AudioRecord.READ_NON_BLOCKING)
                if (n < 0) throw IOException("Microphone unavailable")
                if (n == 0) { Thread.sleep(4); continue }
                offset += n
                if (offset == BYTES) {
                    synchronized(gate) { if (live.get()) send(buffer) } // channel takes its own snapshot synchronously
                    if (first) { first = false; captureReady.countDown() }
                    offset = 0
                }
            }
        } finally {
            synchronized(gate) {
                recording = null
                if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) runCatching { record.stop() }
                echo?.release(); record.release()
            }
        }
    }

    private fun playback() {
        val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(min > 0)
        val track = AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(format(AudioFormat.CHANNEL_OUT_MONO))
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(min, BYTES * 4)).build()
        try {
            check(track.state == AudioTrack.STATE_INITIALIZED)
            synchronized(gate) {
                if (!live.get()) return
                output = track
            }
            var framesWritten = 0L
            val silence = ByteArray(BYTES)
            val stamp = AudioTimestamp()
            var receivedAudio = false
            while (live.get()) {
                when (val next = queue.poll(40, TimeUnit.MILLISECONDS)) {
                    is ByteArray -> {
                        if (framesWritten == 0L) {
                            // Opening the microphone can reconfigure the phone's voice route.
                            // Finish that before playing any of the question.
                            worker("Away capture", ::capture)
                            if (!captureReady.await(1500, TimeUnit.MILLISECONDS)) throw IOException("Microphone not ready")
                            synchronized(gate) {
                                if (!live.get()) return
                                track.play()
                            }
                        }
                        write(track, next)
                        framesWritten += BYTES / 2
                        if (framesWritten == BYTES / 2L && live.get()) {
                            ready()
                        }
                        receivedAudio = true
                    }
                    is String -> {
                        check(receivedAudio)
                        val target = framesWritten
                        val deadline = SystemClock.elapsedRealtime() + 3500
                        // After the last speech packet an underfilled stream may not start or
                        // update its presentation timestamp. Clock it with silence *after* target.
                        var padding = 0
                        while (live.get()) {
                            if (track.getTimestamp(stamp) && presented(target, stamp.framePosition, stamp.nanoTime, System.nanoTime())) break
                            if (SystemClock.elapsedRealtime() >= deadline) throw IOException("No playout timestamp")
                            if (padding < track.bufferSizeInFrames + RATE / 4) {
                                write(track, silence); padding += BYTES / 2; framesWritten += BYTES / 2
                            } else Thread.sleep(5)
                        }
                        Log.i("AwayAudio", "playout_fence underruns=${track.underrunCount}")
                        synchronized(gate) { if (live.get()) played(next) }
                        receivedAudio = false
                    }
                }
            }
        } finally {
            synchronized(gate) { output = null; runCatching { track.pause(); track.flush() }; track.release() }
        }
    }

    private fun write(track: AudioTrack, pcm: ByteArray) {
        var offset = 0
        val deadline = SystemClock.elapsedRealtime() + 1500
        while (live.get() && offset < pcm.size) {
            val n = track.write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_NON_BLOCKING)
            if (n < 0 || SystemClock.elapsedRealtime() > deadline) throw IOException("Playback unavailable")
            if (n == 0) Thread.sleep(3) else offset += n
        }
    }

    override fun close() {
        invalidate()
        synchronized(gate) {
            recording?.let { if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) runCatching { it.stop() } }
            output?.let { runCatching { it.pause(); it.flush() } }
        }
        queue.clear()
        previousMode?.let { if (audio.mode == AudioManager.MODE_IN_COMMUNICATION) runCatching { audio.mode = it } }
        previousMode = null
        if (ownsFocus) { audio.abandonAudioFocusRequest(focus); ownsFocus = false }
    }

    companion object {
        private const val RATE = 24000
        private const val BYTES = 960
        private fun format(mask: Int) = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(RATE).setChannelMask(mask).build()
    }
}
