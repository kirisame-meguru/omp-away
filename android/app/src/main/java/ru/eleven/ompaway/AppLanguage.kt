package ru.eleven.ompaway

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.app.LocaleManagerCompat
import androidx.core.os.LocaleListCompat

/** AppCompat owns persistence below API 33; the platform owns it on newer Android. */
internal object AppLanguage {
    @Volatile private var legacyLocales = LocaleListCompat.getEmptyLocaleList()

    fun initialize(context: Context) {
        if (Build.VERSION.SDK_INT < 33) legacyLocales = LocaleManagerCompat.getApplicationLocales(context)
    }

    fun selected(context: Context): String =
        (if (Build.VERSION.SDK_INT >= 33) LocaleManagerCompat.getApplicationLocales(context)
        else legacyLocales).get(0)?.language.orEmpty()

    fun select(language: String) {
        val locales = LocaleListCompat.forLanguageTags(language)
        if (Build.VERSION.SDK_INT < 33) legacyLocales = locales
        AppCompatDelegate.setApplicationLocales(locales)
    }

    fun context(context: Context): Context {
        if (Build.VERSION.SDK_INT >= 33 || context is AppCompatActivity) return context
        val locales = if (legacyLocales.isEmpty) LocaleManagerCompat.getSystemLocales(context) else legacyLocales
        if (context.resources.configuration.locales.toLanguageTags() == locales.toLanguageTags()) return context
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocales(android.os.LocaleList.forLanguageTags(locales.toLanguageTags()))
        return context.createConfigurationContext(configuration)
    }

    // Resolve a resource, not the device's first locale: unsupported locales fall back to English.
    fun effective(context: Context): String = AppLanguage.context(context).getString(R.string.app_language_tag)
}

internal fun Context.uiString(resource: Int): String = AppLanguage.context(this).getString(resource)

internal fun Context.uiString(resource: Int, argument: Any): String =
    AppLanguage.context(this).getString(resource, argument)

/** Local status messages remain translatable; authenticated desktop prose stays verbatim. */
internal data class UiMessage(val resource: Int = 0, val argument: String? = null, val text: String? = null) {
    fun resolve(context: Context): String = text ?: if (argument == null) context.uiString(resource)
        else context.uiString(resource, argument)
}
