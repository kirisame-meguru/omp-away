package ru.eleven.ompaway

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import javax.net.ssl.SSLException

/** Fixed vocabulary: never pass question content, credentials, addresses, or exception messages. */
internal enum class DiagnosticEvent {
    TUNNEL_CLOSED, TUNNEL_TIMEOUT, TUNNEL_UNAVAILABLE, INVALID_TUNNEL, RELAY_REJECTED,
    SECURE_CHANNEL_REJECTED, ENROLLMENT_FAILED, ENROLLMENT_REJECTED,
    REMOTE_VOICE_UNAVAILABLE, REMOTE_REQUEST_UNAVAILABLE, REMOTE_INBOX_UNAVAILABLE,
    REMOTE_INBOX_TOO_LARGE, PUSH_TOKEN_UNAVAILABLE, PUSH_TOKEN_REJECTED,
    APP_STARTED, APP_CRASH, APP_FOREGROUND, APP_BACKGROUND,
    CONNECT_REQUESTED, CONNECT_RETRY, TRANSPORT_OPEN, TRANSPORT_FAILURE, TRANSPORT_CLOSED,
    TRANSPORT_PROTOCOL_FAILURE, INBOX_RECEIVED, ANSWER_SENT, ANSWER_RECEIVED,
    JOIN_REQUESTED, JOIN_REJECTED, JOIN_PERMISSION_DENIED, CALL_STARTED, CALL_READY,
    FOREGROUND_REQUESTED, FOREGROUND_READY, FOREGROUND_FAILED, FOREGROUND_DESTROYED,
    REMOTE_JOINED, REMOTE_JOIN_REJECTED, HANGUP_SENT,
    END_USER, END_DESKTOP, END_QUESTION_REMOVED, END_BACKGROUND, END_RECONNECT,
    END_TRANSPORT_ERROR, END_TRANSPORT_LOST, END_AUDIO, END_FOREGROUND, END_JOIN_TIMEOUT,
    AUDIO_START, AUDIO_PERMISSION_DENIED, AUDIO_IN_CALL, AUDIO_FOCUS_DENIED, AUDIO_FOCUS_LOST,
    AUDIO_ROUTE_FAILED, AUDIO_START_FAILED, AUDIO_INVALID_FRAME, AUDIO_QUEUE_FULL,
    AUDIO_MARK_QUEUE_FULL, AUDIO_CAPTURE_EXCEPTION, AUDIO_PLAYBACK_EXCEPTION,
    CAPTURE_CREATED, CAPTURE_STARTED, CAPTURE_READY, CAPTURE_PERMISSION_REVOKED,
    CAPTURE_SILENCED, CAPTURE_IN_CALL, CAPTURE_READ_FAILED,
    PLAYBACK_CREATED, PLAYBACK_STARTED, PLAYBACK_READY, PLAYBACK_CAPTURE_TIMEOUT,
    PLAYBACK_TIMESTAMP_TIMEOUT, PLAYBACK_WRITE_FAILED, AUDIO_INVALIDATED, AUDIO_CLOSED,
    DEBUG_CAPTURE_FAILED, DEBUG_CAPTURE_LIMIT,
}


internal fun transportDiagnostic(code: String): DiagnosticEvent = when (code) {
    "tunnel_closed" -> DiagnosticEvent.TUNNEL_CLOSED
    "tunnel_timeout" -> DiagnosticEvent.TUNNEL_TIMEOUT
    "tunnel_unavailable" -> DiagnosticEvent.TUNNEL_UNAVAILABLE
    "invalid_tunnel" -> DiagnosticEvent.INVALID_TUNNEL
    "relay_rejected" -> DiagnosticEvent.RELAY_REJECTED
    "secure_channel_rejected" -> DiagnosticEvent.SECURE_CHANNEL_REJECTED
    "enrollment_failed" -> DiagnosticEvent.ENROLLMENT_FAILED
    "enrollment_rejected" -> DiagnosticEvent.ENROLLMENT_REJECTED
    "voice-unavailable" -> DiagnosticEvent.REMOTE_VOICE_UNAVAILABLE
    "request-unavailable" -> DiagnosticEvent.REMOTE_REQUEST_UNAVAILABLE
    "inbox-unavailable" -> DiagnosticEvent.REMOTE_INBOX_UNAVAILABLE
    "inbox-too-large" -> DiagnosticEvent.REMOTE_INBOX_TOO_LARGE
    "push_token_unavailable" -> DiagnosticEvent.PUSH_TOKEN_UNAVAILABLE
    "push_token_rejected" -> DiagnosticEvent.PUSH_TOKEN_REJECTED
    else -> DiagnosticEvent.TRANSPORT_PROTOCOL_FAILURE
}
/** Two rotating files, retained across process restarts. Synchronous only for sparse state/failure events. */
internal class DiagnosticJournal(
    private val directory: File,
    private val enabled: Boolean = true,
    private val maxBytes: Long = 256 * 1024,
) {
    init { require(maxBytes >= 256) }

    @Synchronized
    fun record(event: DiagnosticEvent, code: Int = 0, error: Throwable? = null): Boolean {
        if (!enabled) return false
        // Deliberately exclude Throwable.message, toString(), stack traces, and cause payloads.
        val category = when (error) {
            null -> "none"
            is SSLException -> "tls"
            is SecurityException -> "security"
            is IOException -> "io"
            is IllegalStateException -> "state"
            is IllegalArgumentException -> "argument"
            is InterruptedException -> "interrupted"
            else -> "other"
        }
        val bytes = "${System.currentTimeMillis()} ${event.name} code=$code error=$category\n".toByteArray(Charsets.UTF_8)
        return try {
            if (!directory.isDirectory && !directory.mkdirs()) return false
            val current = File(directory, "events.log")
            if (current.length() + bytes.size > maxBytes) {
                val previous = File(directory, "events.previous.log")
                if (previous.exists() && !previous.delete()) return false
                if (!current.renameTo(previous)) return false
            }
            FileOutputStream(current, true).use { it.write(bytes) }
            true
        } catch (_: Exception) {
            // Diagnostics must never turn a recoverable application error into a call failure.
            false
        }
    }
}

internal object DebugDiagnostics {
    @Volatile private var journal: DiagnosticJournal? = null
    @Volatile private var captureRoot: File? = null

    fun beginCall(): DebugCallCapture? = captureRoot?.let { DebugCallCapture.open(it) }

    fun initialize(context: Context) {
        if (!BuildConfig.DEBUG || journal != null) return
        try {
            journal = DiagnosticJournal(File(context.noBackupFilesDir, "diagnostics"))
            captureRoot = File(context.noBackupFilesDir, "diagnostics/voice")
            record(DiagnosticEvent.APP_STARTED, BuildConfig.VERSION_CODE)
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            if (previous != null) Thread.setDefaultUncaughtExceptionHandler { thread, error ->
                record(DiagnosticEvent.APP_CRASH, error = error)
                previous.uncaughtException(thread, error)
            }
        } catch (_: Exception) {
            // A restricted files directory or handler policy must not prevent application startup.
            journal = null
            captureRoot = null
        }
    }

    fun transportFailure(code: String) {
        if (journal != null) record(transportDiagnostic(code))
    }

    fun record(event: DiagnosticEvent, code: Int = 0, error: Throwable? = null) {
        journal?.record(event, code, error)
    }
}
