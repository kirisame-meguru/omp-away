package ru.eleven.ompaway

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Started only from a visible, explicit Answer action with microphone permission. Never from push. */
class VoiceForegroundService : Service() {
    private var requestId: String? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as Gateway
        val id = intent?.getStringExtra(Invites.ID)
        if (id == null || app.callId != id) { stopSelf(startId); return START_NOT_STICKY }
        requestId = id
        try {
            startForeground(NOTIFICATION_ID, Invites.notification(this, id, app.store.state.pending[id], ongoing = true),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            app.voiceForegroundReady(id)
        } catch (_: RuntimeException) {
            app.voiceForegroundFailed(id)
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }
    override fun onDestroy() {
        val id = requestId; requestId = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (id != null) (application as Gateway).voiceForegroundFailed(id)
        super.onDestroy()
    }
    companion object {
        private const val NOTIFICATION_ID = 4092
        internal fun start(context: Context, id: String) {
            context.startForegroundService(Intent(context, VoiceForegroundService::class.java).putExtra(Invites.ID, id))
        }
        internal fun stop(context: Context) { context.stopService(Intent(context, VoiceForegroundService::class.java)) }
    }
}
