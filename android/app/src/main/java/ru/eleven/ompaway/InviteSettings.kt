package ru.eleven.ompaway

import android.content.Context

internal class InviteSettings(context: Context) {
    private val prefs = context.getSharedPreferences("invitation-settings", Context.MODE_PRIVATE)
    // Private by default, including unlocked heads-up banners. Public lock-screen versions are always redacted.
    var showPreview: Boolean
        get() = prefs.getBoolean("show-preview", false)
        set(value) { prefs.edit().putBoolean("show-preview", value).commit() }
}
