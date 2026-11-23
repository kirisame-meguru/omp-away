package ru.eleven.ompaway

import kotlin.math.exp

internal class CallVisualState {
    var mode = 0
        private set
    var level = 0f
        private set
    private var lastOutput = Long.MIN_VALUE
    fun update(active: Boolean, connected: Boolean, microphone: Float, playback: Float,
               nowMillis: Long, dtSeconds: Float, still: Boolean) {
        val input = if (microphone.isFinite()) microphone.coerceIn(0f, 1f) else 0f
        val output = if (playback.isFinite()) playback.coerceIn(0f, 1f) else 0f
        if (!active || !connected) {
            mode = if (active) 0 else 4
            lastOutput = Long.MIN_VALUE
            level = 0f
            return
        }
        if (output > 0f) lastOutput = nowMillis
        val speaking = lastOutput != Long.MIN_VALUE && nowMillis - lastOutput in 0..280
        mode = if (speaking) 2 else 1
        if (still) { level = 0f; return }
        val target = if (speaking) output else input
        val dt = if (dtSeconds.isFinite()) dtSeconds.coerceIn(0f, .1f) else 0f
        val response = if (target > level) .035f else .16f
        level += (target - level) * (1f - exp(-dt / response))
    }
}
