package ru.eleven.ompaway

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** Sensitive local debug artifacts. Never export or include these files in backups automatically. */
internal class DebugCallCapture private constructor(directory: File, audioLimit: Long, textLimit: Long) : AutoCloseable {
    private val received = Sink(File(directory, "received.s16le"), audioLimit, 0)
    private val microphone = Sink(File(directory, "microphone.s16le"), audioLimit, 1)
    private val transcripts = Sink(File(directory, "transcripts.txt"), textLimit, 2)

    @Synchronized fun pcm(microphone: Boolean, pcm: ByteArray) {
        if (pcm.size == 960) (if (microphone) this.microphone else received).write(pcm)
    }

    @Synchronized fun transcript(role: String, text: String, final: Boolean) {
        if (role != "user" && role != "assistant") return
        transcripts.write("${System.currentTimeMillis()} $role final=$final\n$text\n\n".toByteArray(Charsets.UTF_8))
    }

    @Synchronized override fun close() {
        received.close(); microphone.close(); transcripts.close()
    }

    private class Sink(private val file: File, private val limit: Long, private val code: Int) {
        private var output: FileOutputStream? = null
        private var written = 0L
        private var closed = false

        fun write(bytes: ByteArray) {
            if (closed) return
            if (bytes.size > limit - written) {
                close()
                DebugDiagnostics.record(DiagnosticEvent.DEBUG_CAPTURE_LIMIT, code)
                return
            }
            try {
                val stream = output ?: FileOutputStream(file, true).also { output = it }
                // Direct writes preserve reused microphone buffers without an extra PCM copy,
                // and do not leave the final failure's audio in a userspace buffering layer.
                stream.write(bytes)
                written += bytes.size
            } catch (error: Exception) {
                close()
                DebugDiagnostics.record(DiagnosticEvent.DEBUG_CAPTURE_FAILED, code, error)
            }
        }

        fun close() {
            closed = true
            try { output?.close() } catch (_: Exception) { }
            output = null
        }
    }

    companion object {
        fun open(root: File, enabled: Boolean = true, audioLimit: Long = 16 * 1024 * 1024, textLimit: Long = 1024 * 1024): DebugCallCapture? {
            if (!enabled) return null
            return try {
                require(audioLimit >= 960 && textLimit >= 256)
                if (!root.isDirectory && !root.mkdirs()) return null
                val current = File(root, "current")
                val previous = File(root, "previous")
                if (previous.exists() && !previous.deleteRecursively()) return null
                if (current.exists() && !current.renameTo(previous)) return null
                if (!current.mkdir()) return null
                for (name in arrayOf("received.s16le", "microphone.s16le", "transcripts.txt")) {
                    if (!File(current, name).createNewFile()) throw IOException("Debug capture unavailable")
                }
                File(current, "format.txt").writeText(
                    "Started: ${System.currentTimeMillis()}\nPCM: signed 16-bit little-endian, 24000 Hz, mono, 960-byte frames.\n" +
                        "Received audio is not proof of playback. Microphone audio is captured only during the call.\n" +
                        "Limits: $audioLimit bytes per audio direction; $textLimit transcript bytes.\n"
                )
                DebugCallCapture(current, audioLimit, textLimit)
            } catch (error: Exception) {
                DebugDiagnostics.record(DiagnosticEvent.DEBUG_CAPTURE_FAILED, error = error)
                null
            }
        }
    }
}
