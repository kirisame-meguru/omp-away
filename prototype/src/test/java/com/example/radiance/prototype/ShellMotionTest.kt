package com.example.radiance.prototype

import org.junit.Assert.*
import org.junit.Test

class ShellMotionTest {
    private fun settle(shell: ShellMotion) { repeat(240) { shell.advance(1f / 120f) } }

    @Test fun listeningRetainsTheApprovedLensExactly() {
        val shell = ShellMotion()
        shell.target(4, true)
        shell.target(1, false)
        assertTrue(shell.moving)
        shell.advance(.1f)
        assertTrue(shell.height in .1f..1f)
        settle(shell)
        assertEquals(1f, shell.width, 0f)
        assertEquals(1f, shell.height, 0f)
        assertEquals(0f, shell.lift, 0f)
        assertEquals(1f, shell.opacity, 0f)
        assertEquals(2.55f, shell.shape, 0f)
        assertFalse(shell.moving)
    }

    @Test fun speakingAndIdleHaveDistinctShellsWithoutChangingWaveEnergy() {
        val shell = ShellMotion()
        shell.target(2, true)
        assertTrue(shell.width > 1f)
        assertTrue(shell.height < 1f)
        shell.target(3, true)
        assertTrue(shell.width < 1f)
        assertTrue(shell.height < .3f)
        assertEquals(1f, shell.opacity, 0f)
        shell.target(0, true)
        assertTrue(shell.height < .3f)
    }

    @Test fun dismissalRetractsBeforeItBecomesInvisible() {
        val shell = ShellMotion()
        shell.target(1, true)
        shell.target(4, false)
        shell.advance(.08f)
        assertTrue(shell.height < 1f)
        assertTrue(shell.lift > 0f)
        assertTrue(shell.opacity > 0f && shell.opacity < 1f)
        settle(shell)
        assertEquals(0f, shell.opacity, 0f)
        assertFalse(shell.moving)
    }

    @Test fun retargetingPreservesPoseAndMomentum() {
        val shell = ShellMotion()
        shell.target(4, true)
        shell.target(1, false)
        shell.advance(.1f)
        val before = shell.height
        shell.target(4, false)
        assertEquals(before, shell.height, 0f)
        shell.advance(.001f)
        assertTrue("Opening velocity must not be reset on interruption", shell.height > before)
        settle(shell)
        assertEquals(0f, shell.opacity, 0f)
    }

    @Test fun repeatedTargetsDoNotRestartAndFrameRatesAgree() {
        val slow = ShellMotion()
        val fast = ShellMotion()
        slow.target(4, true); fast.target(4, true)
        slow.target(1, false); fast.target(1, false)
        repeat(6) { slow.target(1, false); slow.advance(1f / 30f) }
        repeat(24) { fast.advance(1f / 120f) }
        assertEquals(slow.width, fast.width, .00001f)
        assertEquals(slow.height, fast.height, .00001f)
        assertEquals(slow.lift, fast.lift, .00001f)
    }

    @Test fun reducedMotionSnapsAndClearsVelocityEvenDuringTransition() {
        val shell = ShellMotion()
        shell.target(4, false)
        shell.advance(.1f)
        shell.target(2, true)
        val height = shell.height
        assertFalse(shell.moving)
        shell.advance(.1f)
        assertEquals(height, shell.height, 0f)
        shell.target(1, true)
        assertEquals(1f, shell.height, 0f)
    }

    @Test fun invalidDeltasCannotPoisonThePoseAndLongFramesAreBounded() {
        val shell = ShellMotion()
        shell.target(4, false)
        shell.advance(Float.NaN); shell.advance(Float.POSITIVE_INFINITY); shell.advance(-1f)
        assertEquals(1f, shell.height, 0f)
        shell.advance(100f)
        assertTrue(shell.height.isFinite())
        assertTrue("A resume gap must not consume the whole transition", shell.moving)
    }
}
