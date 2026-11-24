package ru.eleven.ompaway

import kotlin.math.sqrt

/** Bounded metadata only: PCM never leaves the existing capture/playback pipeline. */
internal class AudioVisualLevels(capacity: Int = 128) {
    companion object {
        fun power(pcm: ByteArray): Long {
            var sum = 0L
            for (i in 0 until pcm.size - 1 step 2) {
                val sample = ((pcm[i].toInt() and 255) or (pcm[i + 1].toInt() shl 8)).toShort().toLong()
                sum += sample * sample
            }
            return sum
        }

        fun level(power: Long, samples: Int): Float {
            if (samples <= 0 || power <= 0) return 0f
            val rms = sqrt(power.toDouble() / samples).toFloat()
            return sqrt(((rms - 64f) / (8192f - 64f)).coerceIn(0f, 1f))
        }
    }

    init { require(capacity > 0) }
    private val starts = LongArray(capacity)
    private val ends = LongArray(capacity)
    private val levels = FloatArray(capacity)
    private var head = 0
    private var count = 0
    private var closed = false
    private var mic = 0f
    private var micAt = Long.MIN_VALUE

    fun capture(pcm: ByteArray, nowMillis: Long) {
        val value = level(power(pcm), pcm.size / 2)
        synchronized(this) {
            if (!closed) { mic = value; micAt = nowMillis }
        }
    }

    @Synchronized fun microphone(nowMillis: Long): Float =
        if (!closed && nowMillis >= micAt && nowMillis - micAt in 0..160) mic else 0f

    @Synchronized fun enqueue(firstFrame: Long, frames: Int, power: Long) {
        if (closed || frames <= 0) return
        if (count == levels.size) { head = (head + 1) % levels.size; count-- }
        val index = (head + count) % levels.size
        starts[index] = firstFrame
        ends[index] = firstFrame + frames
        levels[index] = level(power, frames)
        count++
    }

    @Synchronized fun playback(frame: Long): Float {
        if (closed || frame <= 0) return 0f
        while (count > 0 && frame >= ends[head]) {
            head = (head + 1) % levels.size
            count--
        }
        return if (count > 0 && frame >= starts[head]) levels[head] else 0f
    }

    @Synchronized fun close() {
        closed = true; mic = 0f; count = 0
    }
}
