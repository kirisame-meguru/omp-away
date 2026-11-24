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
import org.json.JSONArray
import org.json.JSONObject

class Gateway : Application() {
    internal lateinit var store: InboxStore
        private set
    private val main = Handler(Looper.getMainLooper())
    private val audioSettings by lazy { CallAudioSettings(this) }
    internal val speakerEnabled get() = audioSettings.speakerEnabled
    internal val inviteSettings by lazy { InviteSettings(this) }
    internal val needsRelayOrigin get() = current().channel.needsRelayOrigin()
    internal fun migrateRelayOrigin(origin: String) {
        if (observer == null || !idle) return
        status = "Restoring relay setup without replacing paired keys…"
        current().channel.migrateRelayOrigin(origin); changed()
    }
    private var requestedJoin: String? = null
    private var voiceForeground = false
    private var joinSent = false
    private var invitationObserver: (() -> Unit)? = null
    private val tokenState = TokenUpdates()
    @Volatile private var session: Session? = null
    private var observer: (() -> Unit)? = null
    private var voiceObserver: (() -> Unit)? = null
    internal var speaking = false
        private set
    internal var callerCaption = ""
        private set
    internal var assistantCaption = ""
        private set
    internal var callerCaptionFinal = false
        private set
    internal var assistantCaptionFinal = false
        private set
    private var syncJob: ((Boolean) -> Unit)? = null
    private val timeout = Runnable { finishSync(true) }
    private val joinTimeout = Runnable { if (call != null && !talking) endCall("Voice did not become ready. Request remains pending.") }
    @Volatile private var call: CallService? = null
    internal val callId: String? get() = call?.id
    internal val callVisual: CallVisualSource? get() = call
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
    internal val forms = mutableMapOf<String, JSONObject>()
    internal val drafts = mutableMapOf<String, JSONObject>()
    internal val noteDrafts = mutableMapOf<String, JSONArray>()
    internal val formMessages = mutableMapOf<String, String>()
    internal val submitting = mutableSetOf<String>()
    internal var answerReceipt: String? = null
        private set
    private val loadingForms = mutableSetOf<String>()
    private val awaitingReceipts = mutableSetOf<String>()

    internal fun loadForm(id: String) {
        if (!verifiedInbox || id !in store.state.pending || id in forms || id in formMessages || !loadingForms.add(id)) return
        val s = current()
        s.channel.form(id)
        main.postDelayed({
            if (session === s && loadingForms.remove(id)) {
                formMessages[id] = "Question did not arrive. Reconnect to refresh."
                changed()
            }
        }, 30_000)
    }

    internal fun answer(id: String, values: JSONObject, notes: JSONArray) {
        if (observer == null || !verifiedInbox || !idle || requestedJoin != null ||
            id !in forms || id !in store.state.pending || id in submitting) return
        acknowledge(id)
        answerReceipt = null
        submitting.add(id); formMessages[id] = "Submitting…"
        awaitingReceipts.add(id)
        drafts[id] = values; noteDrafts[id] = notes
        val s = current()
        if (!s.channel.answer(id, values, notes)) {
            submitting.remove(id)
            awaitingReceipts.remove(id)
            formMessages[id] = "Answer was not sent. Check the connection or shorten your text."
            changed(); return
        }
        main.postDelayed({
            if (session === s && id in submitting && formMessages[id] == "Submitting…") {
                formMessages[id] = "Submission not confirmed. Check the desktop before retrying."
                changed()
            }
        }, 30_000)
        changed()
    }

    private fun invalidateForms() {
        forms.clear(); loadingForms.clear()
        awaitingReceipts.clear()
        formMessages.keys.retainAll(submitting)
        for (id in submitting) formMessages[id] = "Submission not confirmed. Check the desktop before retrying."
    }

    override fun onCreate() {
        super.onCreate()
        store = InboxStore(this)
        Invites.ensureChannel(this)
        if (store.needsSync) SilenceJob.schedule(this)
    }

    internal fun onMainAndWait(action: Gateway.() -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) { action(); return }
        val work = FutureTask<Unit> { action() }
        main.post(work); work.get()
    }

    private fun current() = session ?: Session().also { session = it }
    private fun changed() { observer?.invoke(); invitationObserver?.invoke() }

    internal fun observeInvitation(observer: (() -> Unit)?) { invitationObserver = observer }

    internal fun invitationSettingsChanged() {
        // A settings change is never a new invitation, and must stop existing ringing.
        store.suppressExistingAlerts()
        for (id in store.state.invited) {
            Invites.cancel(this, id)
            if (id !in store.state.closed && id !in store.state.silenced && id !in store.state.acknowledged && id != callId)
                Invites.show(this, id, if (verifiedInbox) store.state.pending[id] else null)
        }
        changed()
    }

    internal fun acknowledge(id: String) { store.acknowledge(id); Invites.cancel(this, id) }

    internal fun setSpeakerEnabled(enabled: Boolean) {
        if (call?.setSpeakerEnabled(enabled) == false) {
            status = "Audio route could not be changed. Previous setting kept."
        } else {
            audioSettings.speakerEnabled = enabled
        }
        changed()
    }

    internal fun foreground(render: () -> Unit, renderVoice: (() -> Unit)? = null) {
        observer = render; voiceObserver = renderVoice
        val s = current()
        if (s.channel.isPaired() && !verifiedInbox && !s.connecting) connect()
        refreshToken()
        changed()
    }

    internal fun background() {
        observer = null; voiceObserver = null
        requestedJoin = null
        if (!voiceForeground) endCall(null)
        if (call == null && (syncJob == null || pairing)) retire()
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
        if (BuildConfig.ISOLATED_INTEGRATION) return
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
        if (!validId(id)) return
        store.wakeup(id, allowNotification)
        // A wakeup is not proof of liveness; replace even known previews with a generic sync card.
        if (allowNotification && id !in store.state.closed && id !in store.state.silenced &&
            id !in store.state.acknowledged && id != callId) {
            Invites.cancel(this, id)
            Invites.show(this, id)
        }
        if (verifiedInbox) current().channel.list()
        SilenceJob.schedule(this)
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
            if (!paired) finishSync(false)
            else if (verifiedInbox) current().channel.list()
            else if (!current().connecting) connect()
        }
        return AutoCloseable {
            if (syncJob === done) {
                syncJob = null; main.removeCallbacks(timeout)
                if (observer == null && call == null) retire()
            }
        }
    }

    private fun finishSync(retry: Boolean) {
        val done = syncJob ?: return
        syncJob = null; main.removeCallbacks(timeout)
        if (!retry) store.needsSync = false
        if (observer == null && call == null) retire()
        done(retry)
    }

    internal fun join(id: String) {
        acknowledge(id)
        if (observer == null || !validId(id)) return
        if (id in submitting || forms[id]?.optBoolean("voice", true) == false) {
            status = "Voice is unavailable for this question. Review its answer on the home screen."
            changed(); return
        }
        if (!idle) { status = "End the current call before answering another request."; changed(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status = "Microphone permission is required. Nothing was joined."; changed(); return
        }
        requestedJoin = id
        status = "Checking that this request is still pending…"
        store.state.invalidateDetails()
        if (verifiedInbox) current().channel.list() else connect()
        changed()
    }

    private fun startCall(id: String) {
        val microphone = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (observer == null || !canJoin(store.state, id, verifiedInbox, idle, microphone)) {
            status = "Unable to answer here. Open Away and check microphone permission."; return
        }
        Invites.stopRinging(this)
        val s = current()
        lateinit var media: CallService
        media = CallService(this, id, { pcm -> s.channel.sendPcm(pcm) }, { mark -> s.channel.played(id, mark) }, {
            main.post { if (call === media) endCall("Audio interrupted. Request remains pending.") }
        }, {
            main.post {
                if (call === media && voiceForeground) {
                    main.removeCallbacks(joinTimeout); talking = true; status = "In call"; changed()
                }
            }
        }, { active ->
            main.post {
                if (call === media && speaking != active) { speaking = active; voiceObserver?.invoke() }
            }
        })
        call = media; talking = false; voiceForeground = false; joinSent = false; status = "Starting foreground voice call…"
        speaking = false; callerCaption = ""; assistantCaption = ""
        callerCaptionFinal = false; assistantCaptionFinal = false
        Invites.cancel(this, id)
        main.postDelayed(joinTimeout, 90_000)
        try { VoiceForegroundService.start(this, id) }
        catch (_: RuntimeException) { voiceForegroundFailed(id) }
        changed()
    }

    internal fun voiceForegroundReady(id: String) {
        if (callId != id) return
        voiceForeground = true; joinSent = true
        current().channel.join(id)
    }

    internal fun voiceForegroundFailed(id: String) {
        if (callId == id) endCall("Android could not keep microphone access in the foreground. Reopen Away to answer.")
    }

    internal fun hangup() = endCall("Call ended. The desktop controls the pending request.")

    private fun endCall(message: String?, tellDesktop: Boolean = true) {
        val media = call ?: return
        call = null; talking = false; voiceForeground = false
        VoiceForegroundService.stop(this)
        speaking = false; callerCaption = ""; assistantCaption = ""
        callerCaptionFinal = false; assistantCaptionFinal = false
        main.removeCallbacks(joinTimeout)
        store.state.proposals.remove(media.id)
        media.close()
        val notifyDesktop = tellDesktop && session != null && joinSent
        joinSent = false
        if (notifyDesktop) {
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
        store.state.invalidateDetails()
        invalidateForms()
        old?.channel?.close()
    }

    /** Main-thread authoritative snapshot handler; the live transport invokes it only after pinned TLS. */
    internal fun reconcileInbox(items: List<InboxItem>) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val channel = current().channel
        val removed = store.reconcile(items.map { Pending(it.requestId, it.project, it.question, it.createdAt, it.session) })
        for (id in removed) {
            forms.remove(id); drafts.remove(id); noteDrafts.remove(id)
            loadingForms.remove(id); formMessages.remove(id)
        }
        submitting.removeAll(removed)
        for (id in removed) Invites.cancel(this, id)
        verifiedInbox = true; sentSilences.removeAll(removed)
        val toSilence = store.state.silenced.filter { sentSilences.add(it) }
        toSilence.forEach { channel.silence(it) }
        if (callId?.let { it !in store.state.pending } == true) endCall("Request closed on desktop.")
        else if (call == null) status = "Connected to desktop"
        val answer = requestedJoin
        if (answer != null) {
            requestedJoin = null
            if (answer in store.state.pending) startCall(answer)
            else status = "That request is no longer pending. Nothing was joined."
        }
        for (item in store.state.pending.values) {
            val alert = store.consumeAlert(item.id)
            if (item.id in store.state.invited && item.id !in store.state.silenced && item.id !in store.state.acknowledged && item.id != callId)
                Invites.show(this, item.id, item, alert, !idle)
        }
        store.needsSync = false
        if (syncJob != null) {
            // A list response following silence fences its delivery on this ordered socket.
            if (toSilence.isNotEmpty()) channel.list() else finishSync(false)
        }
        changed()
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

        override fun onInbox(items: List<InboxItem>) = ui { reconcileInbox(items) }

        override fun onForm(requestId: String, form: JSONObject?) = ui {
            loadingForms.remove(requestId)
            if (!verifiedInbox || requestId !in store.state.pending) return@ui
            if (form != null) {
                forms[requestId] = form
                if (requestId !in submitting) formMessages.remove(requestId)
            } else {
                forms.remove(requestId)
                if (requestId !in submitting)
                    formMessages[requestId] = "Touch answers are unavailable for this question. Review details or use voice."
            }
            changed()
        }

        override fun onAnswer(requestId: String, status: String, message: String) = ui {
            if (!awaitingReceipts.remove(requestId)) return@ui
            // An uncertain delivery is never automatically retried, including across reconnects.
            if (status == "invalid" || status == "busy") submitting.remove(requestId)
            if (requestId in store.state.pending) formMessages[requestId] = message
            this@Gateway.status = message
            answerReceipt = message
            if (status == "accepted" || status == "stale") {
                forms.remove(requestId); drafts.remove(requestId); noteDrafts.remove(requestId)
                channel.list()
            }
            changed()
        }

        override fun onQuestion(requestId: String, display: QuestionDisplay?) = ui {
            if (verifiedInbox && store.state.question(requestId, display)) changed()
        }

        override fun onProposal(requestId: String, text: String) = ui {
            if (verifiedInbox && callId == requestId && store.state.proposal(requestId, text)) changed()
        }

        override fun onJoined(requestId: String) {
            val media = call?.takeIf { it.id == requestId && session === this }
            stream = media
            ui {
                if (media != null && call === media && voiceForeground && verifiedInbox && requestId in store.state.pending) {
                    status = "Waiting for the desktop's voice…"
                    media.start(); changed()
                } else channel.hangup(requestId)
            }
        }
        override fun onPcm(pcm: ByteArray) { stream?.receive(pcm) }
        override fun onMark(requestId: String, mark: String) { stream?.takeIf { it.id == requestId }?.mark(mark) }
        override fun onTranscript(requestId: String, role: String, text: String, final: Boolean) = ui {
            if (callId != requestId) return@ui
            if (role == "user") { callerCaption = text; callerCaptionFinal = final }
            else { assistantCaption = text; assistantCaptionFinal = final }
            voiceObserver?.invoke()
        }
        override fun onEnded(requestId: String) {
            stream?.takeIf { it.id == requestId }?.let { stream = null; it.invalidate() }
            ui {
                if (endingId == requestId) endingId = null
                if (callId == requestId) endCall("Call ended by desktop.", false)
                if (observer == null && syncJob == null) retire() else channel.list()
            }
        }
        override fun onError(code: String) = ui {
            if (code == "push_token_unavailable" || code == "push_token_rejected") {
                pushWarning = "Push registration unavailable. Reopen the inbox to retry."
                changed(); return@ui
            }
            requestedJoin = null
            verifiedInbox = false; store.state.invalidateDetails()
            invalidateForms()
            endCall(null); verifyEmoji = null; pairing = false; connecting = false
            status = when (code) {
                "relay_origin_required" -> "Relay setup required. Pairing keys have been retained."
                "relay_origin_rejected" -> "Enter a valid HTTPS relay origin without credentials, path, query or fragment."
                "inbox-too-large" -> "Desktop inbox is too large to synchronize. Requests remain pending; details are unavailable."
                "inbox-unavailable" -> "Desktop inbox is not yet available. Pending sync; cached details cannot be used."
                else -> "Desktop connection error: " + code.takeIf { it.matches(Regex("[a-zA-Z0-9_-]{1,64}")) }.orEmpty()
            }
            changed()
        }
        override fun onDisconnected() {
            val media = stream; stream = null; media?.invalidate()
            ui {
                endCall(null, false); verifiedInbox = false; verifyEmoji = null; pairing = false; connecting = false; sentSilences.clear()
                store.state.invalidateDetails()
                invalidateForms()
                endingId = null
                if (!status.startsWith("Desktop connection error")) status = "Disconnected. Showing cached inbox."
                changed()
            }
        }
    }
}
