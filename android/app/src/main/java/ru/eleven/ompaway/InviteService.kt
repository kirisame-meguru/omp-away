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
import android.app.Person
import android.media.AudioAttributes
import android.media.RingtoneManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

internal object Invites {
    const val ID = "requestId"
    const val NOT_NOW = "ru.eleven.ompaway.NOT_NOW"
    const val HANG_UP = "ru.eleven.ompaway.HANG_UP"
    const val OPEN = "ru.eleven.ompaway.OPEN_INVITE"
    const val ANSWER = "ru.eleven.ompaway.ANSWER_CALL"
    const val CHANNEL = "ask-invites"
    const val CALL_CHANNEL = "incoming-calls"
    const val ONGOING_CHANNEL = "active-calls"
    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.uiString(R.string.desktop_requests), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.uiString(R.string.a_pending_request_on_your_paired_desktop)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(CALL_CHANNEL, context.uiString(R.string.incoming_voice_calls), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.uiString(R.string.incoming_invitations_using_your_system_ringtone_and_vibration_settings)
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
            enableVibration(true)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(ONGOING_CHANNEL, context.uiString(R.string.active_voice_call), NotificationManager.IMPORTANCE_LOW).apply {
            setSound(null, null); enableVibration(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
    }

    fun refreshLanguage(app: Gateway) {
        ensureChannel(app)
        val manager = app.getSystemService(NotificationManager::class.java) ?: return
        for (active in manager.activeNotifications) {
            // Preserve platform-owned ringing and short-lived answer-receipt expiry.
            if (active.id == 2 || active.notification.flags and Notification.FLAG_INSISTENT != 0) continue
            val ongoing = active.notification.channelId == ONGOING_CHANNEL
            val id = if (ongoing) app.callId else active.tag
            if (id == null || !validId(id)) continue
            val item = if (app.verifiedInbox) app.store.state.pending[id] else null
            try { manager.notify(active.tag, active.id, notification(app, id, item, ongoing = ongoing, silent = true)) } catch (_: SecurityException) { }
        }
    }

    fun allowed(context: Context, channel: String = CHANNEL): Boolean =
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        context.getSystemService(NotificationManager::class.java)?.let {
            it.areNotificationsEnabled() && (it.getNotificationChannel(channel)?.importance ?: 0) > NotificationManager.IMPORTANCE_NONE
        } == true

    internal fun intent(context: Context, id: String, action: String, activity: Boolean): PendingIntent {
        val uri = Uri.Builder().scheme("omp-away").authority("invite").appendPath(id).appendPath(action).build()
        val intent = Intent(context, if (activity) InboxActivity::class.java else NotNowReceiver::class.java)
            .setAction(action).setData(uri).putExtra(ID, id)
        if (activity && action == ANSWER) intent.component = ComponentName(context.packageName, "${context.packageName}.AnswerCall")
        if (activity && action == "ru.eleven.ompaway.INCOMING") intent.setClass(context, IncomingCallActivity::class.java)
            .putExtra("expiresAt", android.os.SystemClock.elapsedRealtime() + 45_000)
        return if (activity) PendingIntent.getActivity(context, 0,
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), FLAGS)
        else PendingIntent.getBroadcast(context, 0, intent, FLAGS)
    }

    fun notification(context: Context, id: String, item: Pending? = null, ring: Boolean = false, ongoing: Boolean = false, silent: Boolean = false): Notification {
        val settings = InviteSettings(context)
        val localized = AppLanguage.context(context)
        val channel = if (ongoing) ONGOING_CHANNEL else if (ring) CALL_CHANNEL else CHANNEL
        val title = if (settings.showPreview && item != null)
            item.session?.takeIf { it.isNotBlank() } ?: item.project.takeIf { it.isNotBlank() } ?: context.uiString(R.string.desktop_request)
            else context.uiString(R.string.desktop_request)
        val body = if (ongoing) context.uiString(R.string.voice_call_in_progress)
            else if (item == null) context.uiString(R.string.pending_sync_open_the_inbox_to_reconnect)
            else if (settings.showPreview) item.question else context.uiString(R.string.a_request_is_pending_on_your_paired_desktop)
        val open = intent(context, id, OPEN, true)
        val answer = intent(context, id, ANSWER, true)
        val negative = intent(context, id, if (ongoing) HANG_UP else NOT_NOW, false)
        val publicVersion = Notification.Builder(localized, channel).setSmallIcon(R.drawable.ic_invite)
            .setContentTitle(context.uiString(R.string.desktop_request)).setContentText(if (ongoing) context.uiString(R.string.voice_call_in_progress) else context.uiString(R.string.open_away_to_review))
            .setVisibility(Notification.VISIBILITY_PUBLIC).build()
        val builder = Notification.Builder(localized, channel).setSmallIcon(R.drawable.ic_invite)
            .setContentTitle(title).setContentText(body).setStyle(Notification.BigTextStyle().bigText(body))
            .setWhen(item?.createdAt ?: System.currentTimeMillis()).setShowWhen(true)
            .setCategory(if (ring || ongoing) Notification.CATEGORY_CALL else Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
            .setContentIntent(open).setDeleteIntent(negative).setOnlyAlertOnce(true).setOngoing(ongoing)
        // Suppress sound/vibration on wakeups and refreshes, without changing channels.
        if (silent) builder.setGroup("away-silent-$id").setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
        if (ongoing) {
            if (Build.VERSION.SDK_INT >= 31) builder.setStyle(Notification.CallStyle.forOngoingCall(
                Person.Builder().setName(title).build(), negative))
            else builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.hang_up), negative).build())
        } else if (!ring) {
            // A question is not a call: answer it by touch in the shade, or open it.
            val app = context.applicationContext as? Gateway
            val form = if (settings.showPreview && item != null) app?.notificationForm(id) else null
            if (form == null || !NotificationForm.decorate(context, builder, app!!, id, form, negative)) {
                builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.answer_by_voice), answer).build())
                builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.not_now), negative).build())
            }
        } else {
            if (Build.VERSION.SDK_INT >= 31) builder.setStyle(Notification.CallStyle.forIncomingCall(
                Person.Builder().setName(title).build(), negative, answer))
            else {
                builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.answer_call), answer).build())
                builder.addAction(Notification.Action.Builder(null, context.uiString(R.string.not_now), negative).build())
            }
            // The platform owns ringing and timeout even if our process is killed.
            builder.setTimeoutAfter(45_000)
            val manager = context.getSystemService(NotificationManager::class.java)
            if (context.checkSelfPermission(Manifest.permission.USE_FULL_SCREEN_INTENT) == PackageManager.PERMISSION_GRANTED &&
                (Build.VERSION.SDK_INT < 34 || manager?.canUseFullScreenIntent() == true))
                builder.setFullScreenIntent(intent(context, id, "ru.eleven.ompaway.INCOMING", true), true)
        }
        return builder.build().also { if (ring) it.flags = it.flags or Notification.FLAG_INSISTENT }
    }

    /**
     * Questions are ordinary notifications. Only an explicit desktop call ([call]) rings,
     * and only when no other call is ringing or active.
     */
    fun show(context: Context, id: String, item: Pending? = null, alert: Boolean = false, busy: Boolean = false, call: Boolean = false) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val active = manager.activeNotifications
        if (!call && active.any { it.tag == id && it.notification.flags and Notification.FLAG_INSISTENT != 0 }) return
        val existingRing = active.any { it.notification.flags and Notification.FLAG_INSISTENT != 0 }
        val ring = call && item != null && !busy && !existingRing
        if (call && !ring) return
        val channel = if (ring) CALL_CHANNEL else CHANNEL
        if (!allowed(context, channel)) return
        try {
            if (alert || ring) manager.cancel(id, 1) // A generic pending-sync card must not suppress the first authenticated alert.
            manager.notify(id, 1, notification(context, id, item, ring, silent = !ring && (!alert || item == null)))
        } catch (_: SecurityException) { /* Permission revoked; authenticated inbox remains available. */ }
    }

    /** A short-lived, silent receipt after an answer submitted from the notification shade. */
    fun receipt(context: Context, id: String, text: String) {
        if (!allowed(context)) return
        val note = Notification.Builder(AppLanguage.context(context), CHANNEL).setSmallIcon(R.drawable.ic_invite)
            .setContentTitle(text).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setGroup("away-silent-$id").setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
            .setTimeoutAfter(4_000).setAutoCancel(true).build()
        try { context.getSystemService(NotificationManager::class.java)?.notify(id, 2, note) } catch (_: SecurityException) { }
    }

    fun stopRinging(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        for (active in manager.activeNotifications) {
            if (active.notification.flags and Notification.FLAG_INSISTENT == 0) continue
            manager.cancel(active.tag, active.id)
        }
    }

    fun cancelRinging(context: Context, id: String) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.activeNotifications.any { it.tag == id && it.id == 1 &&
                it.notification.flags and Notification.FLAG_INSISTENT != 0 }) manager.cancel(id, 1)
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
        val id = intent.getStringExtra(Invites.ID)?.takeIf(::validId) ?: return
        val app = context.applicationContext as Gateway
        when (intent.action) {
            Invites.NOT_NOW -> if (app.callId == id) app.hangup() else app.silence(id)
            Invites.HANG_UP -> if (app.callId == id) app.hangup()
        }
    }
}

/** Every opaque invitation/retirement wakeup reconciles through the pinned tunnel, without audio. */
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
        fun schedule(context: Context, urgent: Boolean = false) {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
            val existing = scheduler.getPendingJob(4091)
            if (existing != null && (!urgent || Build.VERSION.SDK_INT < 31 || existing.isExpedited)) return
            // FCM wakeups and user-initiated shade replies can use expedited work.
            // Keep the persistent normal job as the platform/quota fallback.
            if (urgent && Build.VERSION.SDK_INT >= 31) {
                val expedited = JobInfo.Builder(4091, ComponentName(context, SilenceJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setExpedited(true).build()
                if (scheduler.schedule(expedited) == JobScheduler.RESULT_SUCCESS) return
            }
            scheduler.schedule(JobInfo.Builder(4091, ComponentName(context, SilenceJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL).setPersisted(true).build())
        }
    }
}
