package com.example.radiance.prototype

import com.example.radiance.EnergySource

internal object Choreography : EnergySource {
    // Hand-authored timing study of the reference: ten seconds, then a quiet return.
    // This is synthetic input, not recorded audio or a microphone envelope.
    private val times = floatArrayOf(0f,.28f,.38f,.67f,1f,1.4f,1.65f,1.85f,2.1f,2.4f,2.85f,3.03f,3.15f,3.5f,3.75f,4f,4.25f,4.5f,4.8f,4.95f,5.08f,5.18f,5.5f,5.9f,6.15f,6.6f,7f,7.4f,7.9f,8.3f,8.7f,9f,10f,10.8f,12f)
    private val levels = floatArrayOf(0f,0f,.85f,.85f,.55f,0f,0f,.55f,.45f,.3f,.18f,0f,.55f,.72f,.35f,.5f,.8f,.55f,.35f,0f,0f,.85f,.7f,.8f,.95f,.95f,1f,.95f,1f,.9f,.6f,.35f,.3f,0f,0f)
    // 0 connection, 1 listening, 2 speaking, 3 silence, 4 disconnected.
    override fun energy(seconds: Float, mode: Int): Float {
        if (mode != 1 && mode != 2) return 0f
        val phase = ((seconds % 12f) + 12f) % 12f
        var index = 0
        while (index < times.lastIndex - 1 && times[index + 1] < phase) index++
        val t = ((phase - times[index]) / (times[index + 1] - times[index])).coerceIn(0f, 1f)
        val eased = t * t * (3f - 2f * t)
        return levels[index] + (levels[index + 1] - levels[index]) * eased
    }
}
