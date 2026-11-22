package ru.eleven.ompaway

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

internal object Invites {
    const val ID = "requestId"
    const val NOT_NOW = "ru.eleven.ompaway.NOT_NOW"
    const val OPEN = "ru.eleven.ompaway.OPEN_INVITE"
    const val CHANNEL = "ask-invites"
    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, "Desktop requests", NotificationManager.IMPORTANCE_HIGH)
        channel.description = "A pending request on your paired desktop"
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    fun allowed(context: Context): Boolean = (Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        context.getSystemService(NotificationManager::class.java)?.let {
            it.areNotificationsEnabled() && (it.getNotificationChannel(CHANNEL)?.importance ?: 0) > NotificationManager.IMPORTANCE_NONE
        } == true

    fun notification(context: Context, id: String): Notification {
        // Distinct identity without relying on hashCode() or mutable PendingIntent extras.
        val uri = Uri.Builder().scheme("omp-away").authority("invite").appendPath(id).build()
        val open = Intent(context, InboxActivity::class.java).setAction(OPEN).setData(uri).putExtra(ID, id)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val silence = Intent(context, NotNowReceiver::class.java).setAction(NOT_NOW).setData(uri).putExtra(ID, id)
        return Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_invite)
            .setContentTitle("Desktop request").setContentText("Open your inbox to review.")
            .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(PendingIntent.getActivity(context, 0, open, FLAGS)).setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, "Not now", PendingIntent.getBroadcast(context, 0, silence, FLAGS)).build())
            .build()
    }

    fun show(context: Context, id: String) {
        if (!allowed(context)) return
        try { context.getSystemService(NotificationManager::class.java)?.notify(id, 1, notification(context, id)) }
        catch (_: SecurityException) { /* Permission may have just been revoked. The inbox retains the invite. */ }
    }

    fun cancel(context: Context, id: String) { context.getSystemService(NotificationManager::class.java)?.cancel(id, 1) }
}

class InviteService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as Gateway).onMainAndWait { rotatedToken(token) }
    }
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data.keys != setOf(Invites.ID)) return
        val id = message.data[Invites.ID] ?: return
        if (!validId(id)) return
        if (!freshInvite(message.sentTime, message.ttl, System.currentTimeMillis())) return
        (application as Gateway).onMainAndWait { receivedInvite(id, Invites.allowed(this)) }
    }
}

class NotNowReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Invites.NOT_NOW) return
        val id = intent.getStringExtra(Invites.ID) ?: return
        (context.applicationContext as Gateway).silence(id)
    }
}

/** Reconcile Not now on a pinned tunnel without starting an Activity, microphone or playback. */
class SilenceJob : JobService() {
    private var work: AutoCloseable? = null
    override fun onStartJob(params: JobParameters): Boolean {
        work = (application as Gateway).backgroundSync { retry ->
            work = null
            jobFinished(params, retry)
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean {
        work?.close(); work = null
        return true
    }
    companion object {
        fun schedule(context: Context) {
            val job = JobInfo.Builder(4091, ComponentName(context, SilenceJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setOverrideDeadline(5000L).build()
            context.getSystemService(JobScheduler::class.java)?.schedule(job)
        }
    }
}
