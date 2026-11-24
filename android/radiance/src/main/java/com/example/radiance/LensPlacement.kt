package com.example.radiance

import kotlin.math.min

/** Lens-only placement in the original full-viewport material coordinates. */
class LensPlacement(private val topAnchored: Boolean = false, private val density: Float = 1f) {
    var baseRadius = 1f
        private set
    var scale = 1f
        private set
    var restingBottom = 0f
        private set
    var topInset = 0f
        private set
    private var anchorLift = 0f
    private var retractLift = 0f

    fun resize(width: Int, height: Int, topInset: Float = this.topInset) {
        this.topInset = topInset
        if (width <= 0 || height <= 0) return
        baseRadius = min(width, height) * .40f
        val radius = if (topAnchored) min(92f * density, min(width * .26f, height * .17f)) else baseRadius
        scale = radius / baseRadius
        val center = if (topAnchored) topInset + 12f * density + radius * .744f else height * .33f
        restingBottom = center + radius * .744f
        anchorLift = (height * .33f - center) / baseRadius
        retractLift = if (topAnchored) (topInset + radius * .45f) / baseRadius else 0f
    }

    fun lift(shell: ShellMotion) = anchorLift + shell.lift * scale + (1f - shell.opacity) * retractLift
}
