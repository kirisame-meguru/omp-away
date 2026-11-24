package ru.eleven.ompaway

import android.content.Context
import android.view.Window
import android.view.WindowManager

/** Local display choices only; never stores audio, captions or pairing data. */
internal class ScreenPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("screen", Context.MODE_PRIVATE)
    init {
        if (preferences.contains("reducedMotion") || preferences.contains("animateOverride")) {
            val editor = preferences.edit()
            if (!preferences.contains("animations")) {
                editor.putBoolean("animations", !preferences.getBoolean("reducedMotion", false))
            }
            editor.remove("reducedMotion").remove("animateOverride").apply()
        }
    }
    var blockScreenshots: Boolean
        get() = preferences.getBoolean("blockScreenshots", true)
        set(value) { preferences.edit().putBoolean("blockScreenshots", value).apply() }
    var animations: Boolean
        get() = preferences.getBoolean("animations", true)
        set(value) { preferences.edit().putBoolean("animations", value).apply() }
    var lightBackdrop: Boolean
        get() = preferences.getBoolean("lightBackdrop", true)
        set(value) { preferences.edit().putBoolean("lightBackdrop", value).apply() }
    var quality: Int
        get() = preferences.getInt("quality", 0).coerceIn(0, 2)
        set(value) { preferences.edit().putInt("quality", value.coerceIn(0, 2)).apply() }

    fun apply(window: Window?) {
        window ?: return
        if (blockScreenshots) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
}
