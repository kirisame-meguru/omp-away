package ru.eleven.ompaway

import org.junit.Assert.*
import org.junit.Test

class CallVisualStateTest {
    @Test fun onlyPresentedOutputSelectsSpeakingAndMicrophoneDrivesListening() {
        val state = CallVisualState()
        state.update(true, false, .8f, 0f, 1000, .02f, false)
        assertEquals(0, state.mode)
        assertEquals(0f, state.level, 0f)
        state.update(true, true, .8f, 0f, 1020, .02f, false)
        assertEquals(1, state.mode)
        assertTrue(state.level > 0f && state.level < .8f)
        state.update(true, true, .9f, .2f, 1040, .02f, false)
        assertEquals(2, state.mode)
        state.update(true, true, 0f, 0f, 1100, .02f, false)
        assertEquals(2, state.mode)
        state.update(true, true, .6f, 0f, 1400, .02f, false)
        assertEquals(1, state.mode)
    }

    @Test fun finalCallerTurnThinksUntilPlaybackOrNewMicrophoneActivity() {
        val state = CallVisualState()
        state.update(true, true, 0f, 0f, 1000, .02f, false, awaitingReply = true)
        assertEquals(3, state.mode)
        assertEquals(0f, state.level, 0f)
        state.update(true, true, .5f, 0f, 1020, .02f, false, awaitingReply = true)
        assertEquals(1, state.mode)
        state.update(true, true, 0f, .4f, 1040, .02f, false, awaitingReply = true)
        assertEquals(2, state.mode)
        state.update(true, true, 0f, 0f, 1400, .02f, true, awaitingReply = true)
        assertEquals(3, state.mode)
        assertEquals(0f, state.level, 0f)
    }

    @Test fun silenceSettlesAndTerminationCannotLeaveStaleSpeech() {
        val state = CallVisualState()
        repeat(30) { state.update(true, true, 1f, 0f, it * 20L, .02f, false) }
        assertTrue(state.level > .99f)
        repeat(100) { state.update(true, true, 0f, 0f, 600 + it * 20L, .02f, false) }
        assertTrue(state.level < .0001f)
        state.update(false, true, 1f, 1f, 3000, .02f, false)
        assertEquals(4, state.mode)
        assertEquals(0f, state.level, 0f)
    }

    @Test fun reducedMotionAndInvalidLevelsNeverAnimate() {
        val state = CallVisualState()
        state.update(true, true, 1f, 0f, 1000, .02f, true)
        assertEquals(1, state.mode)
        assertEquals(0f, state.level, 0f)
        state.update(true, true, Float.NaN, Float.NaN, 1020, .02f, false)
        assertEquals(0f, state.level, 0f)
    }
}
