package ru.eleven.ompaway.security

/** Old desktops close on an extended list, sometimes after a proactive inbox. Downgrade once only. */
internal class DetailsNegotiation {
    var enabled = true
        private set
    private var supported = false
    fun receivedDetails() { supported = true }
    fun retryLegacy(authenticated: Boolean): Boolean {
        if (!authenticated || !enabled || supported) return false
        enabled = false
        return true
    }
}
