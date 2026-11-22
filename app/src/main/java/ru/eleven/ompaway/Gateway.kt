package ru.eleven.ompaway

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessaging
import ru.eleven.ompaway.security.InboxItem
import ru.eleven.ompaway.security.PairedChannel
import java.util.concurrent.FutureTask

class Gateway : Application() {
    internal lateinit var store: InboxStore
        private set
    private val main = Handler(Looper.getMainLooper())
    private val audioSettings by lazy { CallAudioSettings(this) }
    internal val speakerEnabled get() = audioSettings.speakerEnabled
    private val tokenState = TokenUpdates()
    @Volatile private var session: Session? = null
    private var observer: (() -> Unit)? = null
    private var syncJob: ((Boolean) -> Unit)? = null
    private val timeout = Runnable { finishSync(true) }
    private val joinTimeout = Runnable { if (call != null && !talking) endCall("Voice did not become ready. Request remains pending.") }
    @Volatile private var call: CallService? = null
    internal val callId: String? get() = call?.id
    private var endingId: String? = null
    internal val idle get() = call == null && endingId == null
    internal var talking = false
        private set
    internal var verifiedInbox = false
        private set
    internal var status = "Offline"
        private set
    internal var verifyEmoji: String? = null
        private set
    internal var pairing = false
        private set
    internal val paired get() = current().channel.isPaired()
    private val sentSilences = mutableSetOf<String>()

    override fun onCreate() {
        super.onCreate()
        store = InboxStore(this)
        Invites.ensureChannel(this)
    }

    internal fun onMainAndWait(action: Gateway.() -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) { action(); return }
        val work = FutureTask<Unit> { action() }
        main.post(work); work.get()
    }

    private fun current() = session ?: Session().also { session = it }
    private fun changed() { observer?.invoke() }

    internal fun setSpeakerEnabled(enabled: Boolean) {
        if (call?.setSpeakerEnabled(enabled) == false) {
            status = "Audio route could not be changed. Previous setting kept."
        } else {
            audioSettings.speakerEnabled = enabled
        }
        changed()
    }

    internal fun foreground(render: () -> Unit) {
        observer = render
        val s = current()
        if (s.channel.isPaired() && !verifiedInbox && !s.connecting) connect()
        refreshToken()
        changed()
    }

    internal fun background() {
        observer = null
        endCall(null)
        if (syncJob == null || pairing) retire()
    }

    internal fun connect() {
        val s = current()
        if (!s.channel.isPaired()) return
        s.connecting = true
        status = "Connecting to desktop…"
        s.channel.connect(); changed()
    }

    internal fun retry() {
        endCall(null); retire(); status = "Offline"; connect(); refreshToken(); changed()
    }

    private fun refreshToken() {
        val lookup = tokenState.beginLookup()
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (tokenState.isCurrent(lookup)) {
                pushWarning = null; current().channel.updateFcmToken(token); changed()
            }
        }.addOnFailureListener {
            if (tokenState.isCurrent(lookup)) { pushWarning = "Push registration unavailable. Reopen the inbox to retry."; changed() }
        }
    }

    internal var pushWarning: String? = null
        private set
    internal fun rotatedToken(token: String) {
        tokenState.rotated(); pushWarning = null
        current().channel.updateFcmToken(token)
    }

    internal fun pair(raw: String) {
        if (observer == null || paired || pairing) return
        if (raw.isBlank() || raw.length > 8192) { status = "Invalid pairing code."; changed(); return }
        pairing = true; status = "Verifying desktop identity…"
        runCatching { current().channel.pair(raw) }.onFailure { pairing = false; status = "Invalid pairing code." }
        changed()
    }

    internal fun confirm(emoji: String, accept: Boolean) {
        if (observer == null || emoji != verifyEmoji) return
        verifyEmoji = null
        status = if (accept) "Waiting for desktop approval…" else "Pairing declined."
        current().channel.confirmPair(emoji, accept)
        if (!accept) pairing = false
        changed()
    }

    internal fun receivedInvite(id: String, allowNotification: Boolean) {
        when (store.invite(id, allowNotification)) {
            Arrival.IGNORE -> return
            Arrival.NOTIFY -> Invites.show(this, id)
            Arrival.CACHE -> Unit
        }
        if (verifiedInbox) current().channel.list()
        changed()
    }

    internal fun silence(id: String) {
        if (id !in store.state.pending && id !in store.state.invited) return
        store.silence(id); Invites.cancel(this, id)
        if (verifiedInbox && id in store.state.pending) {
            if (sentSilences.add(id)) current().channel.silence(id)
        } else if (paired) SilenceJob.schedule(this)
        changed()
    }

    internal fun backgroundSync(done: (Boolean) -> Unit): AutoCloseable {
        syncJob = done
        main.postDelayed(timeout, 22_000)
        main.post {
            if (syncJob !== done) return@post
            if (store.state.silenced.isEmpty() || !paired) finishSync(false)
            else if (verifiedInbox) current().channel.list()
            else if (!current().connecting) connect()
        }
        return AutoCloseable {
            if (syncJob === done) {
                syncJob = null; main.removeCallbacks(timeout)
                if (observer == null) retire()
            }
        }
    }

    private fun finishSync(retry: Boolean) {
        val done = syncJob ?: return
        syncJob = null; main.removeCallbacks(timeout)
        if (observer == null) retire()
        done(retry)
    }

    internal fun join(id: String) {
        val microphone = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (observer == null || !canJoin(store.state, id, verifiedInbox, idle, microphone)) return
        val s = current()
        lateinit var media: CallService
        media = CallService(this, id, { pcm -> s.channel.sendPcm(pcm) }, { mark -> s.channel.played(id, mark) }, {
            main.post { if (call === media) endCall("Audio interrupted. Request remains pending.") }
        }, {
            main.post {
                if (call === media && observer != null) {
                    main.removeCallbacks(joinTimeout); talking = true; status = "In call"; changed()
                }
            }
        })
        call = media; talking = false; status = "Joining…"
        Invites.cancel(this, id)
        main.postDelayed(joinTimeout, 90_000)
        s.channel.join(id); changed()
    }

    internal fun hangup() = endCall("Call ended. The desktop controls the pending request.")

    private fun endCall(message: String?, tellDesktop: Boolean = true) {
        val media = call ?: return
        call = null; talking = false
        main.removeCallbacks(joinTimeout)
        media.close()
        if (tellDesktop && session != null) {
            endingId = media.id
            session?.channel?.hangup(media.id)
        }
        if (message != null) status = message
        changed()
    }

    private fun retire() {
        val old = session; session = null
        endingId = null
        verifiedInbox = false; verifyEmoji = null; pairing = false; sentSilences.clear()
        old?.channel?.close()
    }

    private inner class Session : PairedChannel.Listener {
        val channel = PairedChannel(this@Gateway, this)
        var connecting = false
        @Volatile private var stream: CallService? = null
        private fun ui(action: () -> Unit) { main.post { if (session === this) action() } }

        override fun onVerify(emoji: String) = ui {
            if (observer != null && pairing) { verifyEmoji = emoji; changed() } else retire()
        }

        override fun onReady() = ui {
            pairing = false; verifyEmoji = null; connecting = false; verifiedInbox = false
            status = "Refreshing inbox…"; changed()
        }

        override fun onInbox(items: List<InboxItem>) = ui {
            val removed = store.reconcile(items.map { Pending(it.requestId, it.project, it.question, it.createdAt) })
            for (id in removed) Invites.cancel(this@Gateway, id)
            verifiedInbox = true; sentSilences.removeAll(removed)
            val toSilence = store.state.silenced.filter { sentSilences.add(it) }
            toSilence.forEach { channel.silence(it) }
            if (callId?.let { it !in store.state.pending } == true) endCall("Request closed on desktop.")
            else if (call == null) status = "Connected to desktop"
            if (syncJob != null) {
                // A list response following the silence command fences its delivery on this ordered socket.
                if (toSilence.isNotEmpty()) channel.list() else finishSync(false)
            }
            changed()
        }

        override fun onJoined(requestId: String) {
            val media = call?.takeIf { it.id == requestId && session === this }
            stream = media
            ui {
                if (media != null && call === media && observer != null && verifiedInbox && requestId in store.state.pending) {
                    status = "Waiting for the desktop's voice…"
                    media.start(); changed()
                } else channel.hangup(requestId)
            }
        }
        override fun onPcm(pcm: ByteArray) { stream?.receive(pcm) }
        override fun onMark(requestId: String, mark: String) { stream?.takeIf { it.id == requestId }?.mark(mark) }
        override fun onEnded(requestId: String) {
            stream?.takeIf { it.id == requestId }?.let { stream = null; it.invalidate() }
            ui {
                if (endingId == requestId) endingId = null
                if (callId == requestId) endCall("Call ended by desktop.", false)
                channel.list()
            }
        }
        override fun onError(code: String) = ui {
            if (code == "push_token_unavailable" || code == "push_token_rejected") {
                pushWarning = "Push registration unavailable. Reopen the inbox to retry."
                changed(); return@ui
            }
            endCall(null); verifyEmoji = null; pairing = false; connecting = false
            status = "Desktop connection error: " + code.takeIf { it.matches(Regex("[a-zA-Z0-9_-]{1,64}")) }.orEmpty()
            changed()
        }
        override fun onDisconnected() {
            val media = stream; stream = null; media?.invalidate()
            ui {
                endCall(null, false); verifiedInbox = false; verifyEmoji = null; pairing = false; connecting = false; sentSilences.clear()
                endingId = null
                if (!status.startsWith("Desktop connection error")) status = "Disconnected. Showing cached inbox."
                changed()
            }
        }
    }
}
