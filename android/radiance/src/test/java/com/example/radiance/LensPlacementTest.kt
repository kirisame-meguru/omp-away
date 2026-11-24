package com.example.radiance

import org.junit.Assert.*
import org.junit.Test

class LensPlacementTest {
    @Test fun prototypeKeepsItsOriginalFullSizeCenteredLens() {
        val placement = LensPlacement()
        placement.resize(1080, 2400)
        val shell = ShellMotion()
        assertEquals(432f, placement.baseRadius, 0f)
        assertEquals(1f, placement.scale, 0f)
        for (mode in 0..4) {
            shell.target(mode, true)
            assertEquals(shell.lift, placement.lift(shell), 0f)
        }
    }

    @Test fun topLensFitsPortraitLandscapeAndSafeInsetsWithoutMovingTheBackdrop() {
        for ((width, height) in listOf(1080 to 2400, 2400 to 1080, 320 to 480)) {
            val density = if (width == 320) 1f else 3f
            val top = 24f * density
            val placement = LensPlacement(topAnchored = true, density = density)
            placement.resize(width, height, top)
            val shell = ShellMotion()
            shell.target(1, true)
            val radius = placement.baseRadius * placement.scale
            val center = height * .33f - placement.lift(shell) * placement.baseRadius
            assertEquals(top + 12f * density, center - .744f * radius, .001f)
            assertEquals(placement.restingBottom, center + .744f * radius, .001f)
            assertTrue(radius <= 92f * density)
            assertTrue(placement.restingBottom < height * .5f)
            assertTrue(radius * 2.16f < width)
            shell.target(4, true)
            val retractedCenter = height * .33f - placement.lift(shell) * placement.baseRadius
            assertTrue("Retraction must disappear above the viewport", retractedCenter + .744f * radius * shell.height < 0f)
            assertEquals(0f, shell.opacity, 0f)
        }
    }

    @Test fun entryExpandsDownFromTheTopAndRetargetingKeepsTheSameBackdropCoordinates() {
        val placement = LensPlacement(topAnchored = true, density = 3f)
        placement.resize(1080, 2400, 72f)
        val shell = ShellMotion()
        shell.target(4, true)
        val hiddenLift = placement.lift(shell)
        shell.target(0, false)
        repeat(240) { shell.advance(1f / 120f) }
        assertTrue(placement.lift(shell) < hiddenLift)
        val capsuleLift = placement.lift(shell)
        val scale = placement.scale
        shell.target(1, false)
        repeat(240) { shell.advance(1f / 120f) }
        assertTrue(placement.lift(shell) < capsuleLift)
        assertEquals(scale, placement.scale, 0f)
        assertEquals(432f, placement.baseRadius, 0f)
    }

    @Test fun compactLensFitsItsHeaderSlotAndRestoresVoicePlacement() {
        val placement = LensPlacement(topAnchored = true, density = 3f)
        placement.resize(1080, 2160, 72f)
        val voiceScale = placement.scale
        val voiceBottom = placement.restingBottom
        placement.compact = true
        for (size in listOf(56, 112, 168)) {
            placement.resize(size, size, 0f)
            val shell = ShellMotion()
            for (mode in 0..3) {
                shell.target(mode, true)
                val radius = placement.baseRadius * placement.scale
                val center = size * .33f - placement.lift(shell) * placement.baseRadius
                assertTrue("Lens must not cover adjacent controls", radius * shell.width * 2f < size)
                assertTrue(center - radius * shell.height * .744f >= 0f)
                assertTrue(center + radius * shell.height * .744f <= size)
                if (mode == 1) assertEquals(size * .5f, center, .001f)
            }
        }
        placement.compact = false
        placement.resize(1080, 2160, 72f)
        assertEquals(voiceScale, placement.scale, 0f)
        assertEquals(voiceBottom, placement.restingBottom, 0f)
    }
}
