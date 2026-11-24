package com.example.radiance.prototype

import org.junit.Assert.*
import org.junit.Test

class ChoreographyTest {
    @Test fun nonSpeechStatesAreSilent() {
        for (mode in listOf(0, 3, 4)) for (i in 0..100) assertEquals(0f, Choreography.energy(i / 10f, mode), 0f)
    }
    @Test fun speechIsBoundedAndHasPauses() {
        for (mode in 1..2) for (i in 0..1000) assertTrue(Choreography.energy(i / 30f, mode) in 0f..1f)
        assertEquals(0f, Choreography.energy(5f, 2), 0f)
    }
    @Test fun referenceMotionRestsBeforeItsFirstAttack() {
        assertEquals(0f, Choreography.energy(0f, 1), 0f)
        assertEquals(0f, Choreography.energy(.25f, 1), 0f)
        assertTrue(Choreography.energy(.4f, 1) > .7f)
    }
    @Test fun referenceMotionReturnsSmoothlyBeforeLooping() {
        assertEquals(0f, Choreography.energy(11.9f, 2), 0f)
        assertEquals(Choreography.energy(.4f, 2), Choreography.energy(12.4f, 2), .0001f)
        for (i in 1..360) {
            val previous = Choreography.energy((i - 1) / 30f, 2)
            val next = Choreography.energy(i / 30f, 2)
            assertTrue(kotlin.math.abs(next - previous) < .5f)
        }
    }
}
