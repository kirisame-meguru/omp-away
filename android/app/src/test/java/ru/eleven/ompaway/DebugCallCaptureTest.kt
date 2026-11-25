package ru.eleven.ompaway

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DebugCallCaptureTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun disabledCaptureCreatesNothing() {
        val root = File(temporary.root, "disabled")
        assertNull(DebugCallCapture.open(root, enabled = false))
        assertFalse(root.exists())
    }

    @Test fun capturesBothDirectionsAndPartialAndFinalTranscripts() {
        val root = temporary.newFolder()
        val capture = requireNotNull(DebugCallCapture.open(root))
        val frame = ByteArray(960) { it.toByte() }
        capture.pcm(false, frame)
        frame.fill(7)
        capture.pcm(true, frame)
        capture.transcript("user", "Synthetic partial", false)
        capture.transcript("assistant", "Synthetic final\nsecond line", true)
        capture.close()
        assertArrayEquals(ByteArray(960) { it.toByte() }, File(root, "current/received.s16le").readBytes())
        assertArrayEquals(frame, File(root, "current/microphone.s16le").readBytes())
        val text = File(root, "current/transcripts.txt").readText()
        assertTrue(text.contains("user final=false\nSynthetic partial"))
        assertTrue(text.contains("assistant final=true\nSynthetic final\nsecond line"))
        assertTrue(File(root, "current/format.txt").readText().contains("24000"))
    }

    @Test fun keepsOnlyCurrentAndPreviousCallAcrossReopening() {
        val root = temporary.newFolder()
        repeat(3) { index ->
            requireNotNull(DebugCallCapture.open(root)).use { it.pcm(false, ByteArray(960) { index.toByte() }) }
        }
        assertEquals(setOf("current", "previous"), root.list()!!.toSet())
        assertEquals(2.toByte(), File(root, "current/received.s16le").readBytes()[0])
        assertEquals(1.toByte(), File(root, "previous/received.s16le").readBytes()[0])
    }

    @Test fun limitsNeverSplitAudioFramesOrGrowTranscriptStorage() {
        val root = temporary.newFolder()
        requireNotNull(DebugCallCapture.open(root, audioLimit = 1920, textLimit = 256)).use { capture ->
            repeat(10) { capture.pcm(false, ByteArray(960)); capture.pcm(true, ByteArray(960)) }
            repeat(20) { capture.transcript("user", "Synthetic transcript", true) }
        }
        assertEquals(1920L, File(root, "current/received.s16le").length())
        assertEquals(1920L, File(root, "current/microphone.s16le").length())
        assertTrue(File(root, "current/transcripts.txt").length() <= 256)
    }

    @Test fun closedCaptureCannotContaminateTheNextCall() {
        val root = temporary.newFolder()
        val old = requireNotNull(DebugCallCapture.open(root))
        old.close()
        requireNotNull(DebugCallCapture.open(root)).use { current ->
            old.pcm(false, ByteArray(960))
            old.transcript("user", "Stale transcript", true)
            current.pcm(false, ByteArray(960) { 9 })
        }
        assertEquals(0L, File(root, "previous/received.s16le").length())
        assertEquals(0L, File(root, "previous/transcripts.txt").length())
        assertEquals(960L, File(root, "current/received.s16le").length())
    }

    @Test fun unavailableStorageDoesNotBreakCalls() {
        assertNull(DebugCallCapture.open(temporary.newFile()))
    }
}
