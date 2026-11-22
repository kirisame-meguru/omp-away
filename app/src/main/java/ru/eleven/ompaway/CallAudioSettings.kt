package ru.eleven.ompaway

import android.content.Context

internal class CallAudioSettings(context: Context) {
    private val preferences = context.getSharedPreferences("away.audio.v1", Context.MODE_PRIVATE)

    var speakerEnabled: Boolean
        get() = preferences.getBoolean("speaker", false)
        set(value) { preferences.edit().putBoolean("speaker", value).apply() }
}
