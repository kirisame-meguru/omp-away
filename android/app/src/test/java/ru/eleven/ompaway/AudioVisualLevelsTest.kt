package ru.eleven.ompaway

import org.junit.Assert.*
import org.junit.Test

class AudioVisualLevelsTest {
    private fun pcm(sample: Int) = ByteArray(960) { if (it % 2 == 0) sample.toByte() else (sample shr 8).toByte() }

    @Test fun signedLittleEndianRmsIsSymmetricBoundedAndNoiseGated() {
        assertEquals(0f, AudioVisualLevels.level(0, 480), 0f)
        assertEquals(0f, AudioVisualLevels.level(AudioVisualLevels.power(pcm(32)), 480), 0f)
        val quiet = AudioVisualLevels.level(AudioVisualLevels.power(pcm(500)), 480)
        val loud = AudioVisualLevels.level(AudioVisualLevels.power(pcm(4000)), 480)
        assertTrue(quiet > 0f && loud > quiet)
        assertEquals(loud, AudioVisualLevels.level(AudioVisualLevels.power(pcm(-4000)), 480), 0f)
        assertEquals(1f, AudioVisualLevels.level(AudioVisualLevels.power(pcm(-32768)), 480), 0f)
    }

    @Test fun microphoneUsesRealSamplesAndExpiresWhenCaptureStops() {
        val levels = AudioVisualLevels()
        levels.capture(pcm(2000), 1000)
        assertTrue(levels.microphone(1010) > 0f)
        assertEquals(0f, levels.microphone(1200), 0f)
        levels.capture(pcm(0), 1210)
        assertEquals(0f, levels.microphone(1210), 0f)
    }

    @Test fun bufferedOutputDoesNotAnimateBeforeItsFramesArePresented() {
        val levels = AudioVisualLevels()
        levels.enqueue(0, 480, 2000L * 2000 * 480)
        levels.enqueue(480, 480, 4000L * 4000 * 480)
        assertEquals(0f, levels.playback(0), 0f)
        val first = levels.playback(100)
        assertTrue(first > 0f)
        assertTrue(levels.playback(500) > first)
        assertEquals(0f, levels.playback(960), 0f)
    }

    @Test fun silenceAndGapsNeverReuseTheLastOutputLevel() {
        val levels = AudioVisualLevels()
        levels.enqueue(0, 480, 2000L * 2000 * 480)
        levels.enqueue(960, 480, 3000L * 3000 * 480)
        assertTrue(levels.playback(100) > 0f)
        assertEquals(0f, levels.playback(700), 0f)
        assertTrue(levels.playback(1000) > 0f)
        levels.enqueue(1440, 480, 0)
        assertEquals(0f, levels.playback(1500), 0f)
    }

    @Test fun boundedHistoryDropsOnlyVisualSamplesAndCloseRejectsLateWriters() {
        val levels = AudioVisualLevels(2)
        repeat(3) { levels.enqueue(it * 480L, 480, 1000L * 1000 * 480) }
        assertEquals(0f, levels.playback(100), 0f)
        assertTrue(levels.playback(500) > 0f)
        levels.capture(pcm(2000), 1000)
        levels.close()
        levels.capture(pcm(3000), 1001)
        levels.enqueue(1440, 480, 3000L * 3000 * 480)
        assertEquals(0f, levels.microphone(1002), 0f)
        assertEquals(0f, levels.playback(1500), 0f)
    }
}
