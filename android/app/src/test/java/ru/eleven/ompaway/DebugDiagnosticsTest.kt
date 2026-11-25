package ru.eleven.ompaway

import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DebugDiagnosticsTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun disabledJournalDoesNotCreateFiles() {
        val directory = File(temporary.root, "disabled")
        assertFalse(DiagnosticJournal(directory, enabled = false).record(DiagnosticEvent.APP_STARTED))
        assertFalse(directory.exists())
    }

    @Test fun recordsSurviveJournalRecreation() {
        val directory = temporary.newFolder()
        assertTrue(DiagnosticJournal(directory).record(DiagnosticEvent.CALL_STARTED))
        assertTrue(DiagnosticJournal(directory).record(DiagnosticEvent.END_AUDIO))
        val lines = File(directory, "events.log").readLines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].contains("CALL_STARTED"))
        assertTrue(lines[1].contains("END_AUDIO"))
    }

    @Test fun rotationRetainsOnlyTwoBoundedFilesAndTheLatestFailure() {
        val directory = temporary.newFolder()
        val journal = DiagnosticJournal(directory, maxBytes = 256)
        repeat(100) { assertTrue(journal.record(DiagnosticEvent.INBOX_RECEIVED, it)) }
        assertTrue(journal.record(DiagnosticEvent.CAPTURE_SILENCED))
        val files = directory.listFiles()!!
        assertEquals(setOf("events.log", "events.previous.log"), files.map { it.name }.toSet())
        assertTrue(files.all { it.length() <= 256 })
        assertTrue(File(directory, "events.log").readLines().last().contains("CAPTURE_SILENCED"))
    }

    @Test fun exceptionMessagesCausesAndUnknownTransportPayloadsAreNeverSaved() {
        val directory = temporary.newFolder()
        val journal = DiagnosticJournal(directory)
        val secret = "synthetic-sensitive-value https://example.invalid/private"
        val errors = listOf(
            IOException(secret, RuntimeException(secret)), SSLException(secret),
            SecurityException(secret), IllegalStateException(secret), IllegalArgumentException(secret),
            InterruptedException(secret), AssertionError(secret),
        )
        errors.forEach { assertTrue(journal.record(DiagnosticEvent.TRANSPORT_FAILURE, -7, it)) }
        assertTrue(journal.record(transportDiagnostic(secret)))
        val text = File(directory, "events.log").readText()
        assertFalse(text.contains(secret))
        assertFalse(text.contains("https://"))
        assertTrue(text.contains("code=-7 error=io"))
        assertTrue(text.contains("error=tls"))
        assertTrue(text.contains("error=security"))
        assertTrue(text.contains("error=state"))
        assertTrue(text.contains("error=argument"))
        assertTrue(text.contains("error=interrupted"))
        assertTrue(text.contains("error=other"))
        assertTrue(text.contains("TRANSPORT_PROTOCOL_FAILURE"))
        assertEquals(DiagnosticEvent.TUNNEL_TIMEOUT, transportDiagnostic("tunnel_timeout"))
        assertEquals(DiagnosticEvent.SECURE_CHANNEL_REJECTED, transportDiagnostic("secure_channel_rejected"))
    }

    @Test fun storageFailureDoesNotEscapeIntoCallCleanup() {
        val notDirectory = temporary.newFile()
        val journal = DiagnosticJournal(notDirectory)
        assertFalse(journal.record(DiagnosticEvent.END_AUDIO))
        assertFalse(journal.record(DiagnosticEvent.AUDIO_CLOSED))
        assertEquals(0L, notDirectory.length())
    }

    @Test fun concurrentWritersKeepCompleteRecords() {
        val directory = temporary.newFolder()
        val journal = DiagnosticJournal(directory)
        val executor = Executors.newFixedThreadPool(4)
        try {
            val jobs = (0 until 4).map { worker ->
                executor.submit {
                    repeat(100) { check(journal.record(DiagnosticEvent.INBOX_RECEIVED, worker * 100 + it)) }
                }
            }
            jobs.forEach { it.get(10, TimeUnit.SECONDS) }
        } finally { executor.shutdownNow() }
        val lines = File(directory, "events.log").readLines()
        assertEquals(400, lines.size)
        assertTrue(lines.all { it.matches(Regex("[0-9]+ INBOX_RECEIVED code=[0-9]+ error=none")) })
        assertEquals(400, lines.map { it.substringAfter("code=").substringBefore(' ') }.toSet().size)
    }
}
