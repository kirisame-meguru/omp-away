package com.example.radiance.prototype

/** Ignore startup; require three consecutive slow two-second windows. Never oscillate tiers. */
internal class QualityPolicy {
    private var warmup = true
    private var slowWindows = 0
    fun reset() { warmup = true; slowWindows = 0 }
    fun observe(fps: Double): Boolean {
        if (!fps.isFinite() || fps < 0) return false
        if (warmup) { warmup = false; return false }
        slowWindows = if (fps < 27.0) slowWindows + 1 else 0
        return slowWindows >= 3
    }
}
