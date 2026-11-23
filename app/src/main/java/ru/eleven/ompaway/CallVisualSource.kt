package ru.eleven.ompaway

/** Read-only, session-scoped audio levels. No PCM or captions are retained by the renderer. */
internal interface CallVisualSource {
    val active: Boolean
    val connected: Boolean
    fun microphoneLevel(nowMillis: Long): Float
    fun playbackLevel(): Float
}
