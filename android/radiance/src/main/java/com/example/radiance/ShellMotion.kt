package com.example.radiance

import kotlin.math.abs
import kotlin.math.exp

/** Mutable shell pose shared by native and fallback renderers; waves have their own clock. */
class ShellMotion {
    companion object {
        // Width, height, upward displacement (lens radii), visibility, superellipse power.
        private val poses = arrayOf(
            floatArrayOf(.60f, .22f, .50f, 1f, 3.2f), // connecting capsule
            floatArrayOf(1f, 1f, 0f, 1f, 2.55f),     // original listening lens
            floatArrayOf(1.08f, .78f, .12f, 1f, 3f), // wider speaking shell
            floatArrayOf(.58f, .24f, .48f, 1f, 3.2f), // quiet, visible pill
            floatArrayOf(.42f, .10f, .90f, 0f, 2.55f), // retracted
        )
        // Height lags width, giving entry and exit a stretch rather than uniform scaling.
        private val rates = floatArrayOf(18f, 12f, 16f, 12f, 14f)
    }

    private val pose = poses[1].copyOf()
    private val velocity = FloatArray(5)
    private var mode = 1
    val width get() = pose[0]
    val height get() = pose[1]
    val lift get() = pose[2]
    val opacity get() = pose[3]
    val shape get() = pose[4]
    var moving = false
        private set

    fun target(mode: Int, still: Boolean) {
        require(mode in poses.indices)
        if (this.mode != mode) {
            this.mode = mode
            moving = true
        }
        if (still) settle()
    }

    private fun settle() {
        poses[mode].copyInto(pose)
        velocity.fill(0f)
        moving = false
    }

    fun advance(seconds: Float) {
        if (!moving || !seconds.isFinite() || seconds <= 0f) return
        val dt = seconds.coerceAtMost(.1f)
        val target = poses[mode]
        var settled = true
        for (i in pose.indices) {
            // Closed-form critically damped spring: stable at any refresh rate,
            // preserving both pose and velocity when a new target interrupts it.
            val rate = rates[i]
            val delta = pose[i] - target[i]
            val impulse = velocity[i] + rate * delta
            val decay = exp(-rate * dt)
            pose[i] = target[i] + (delta + impulse * dt) * decay
            velocity[i] = (velocity[i] - rate * impulse * dt) * decay
            if (abs(pose[i] - target[i]) > .0001f || abs(velocity[i]) > .001f) settled = false
        }
        if (settled) settle()
    }
}
