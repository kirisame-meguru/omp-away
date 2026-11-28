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
        statusMessage = UiMessage(R.string.restoring_relay_setup_without_replacing_paired_keys)
        current().channel.migrateRelayOrigin(origin); changed()
    }
    private var requestedJoin: String? = null
    private var callLanguage = "en"
    private var displayedLanguage: String? = null
    internal var relayDraft = ""
    private var saveDraftObserver: (() -> Unit)? = null
    private val staleSubmittedForms = mutableSetOf<String>()

    internal fun languageChanged() {
        val language = AppLanguage.effective(this)
        if (displayedLanguage == language) return
        saveDraftObserver?.invoke()
        if (displayedLanguage != null) {
            // Never invalidate submission receipts or silently resubmit after translating a form.
            staleSubmittedForms.addAll(submitting)
            forms.keys.retainAll(submitting)
            formMessages.keys.retainAll(submitting)
            localFormMessages.keys.retainAll(submitting)
            store.state.invalidateDetails()
            notificationForms.keys.retainAll(submitting)
        }
        displayedLanguage = language
        Invites.refreshLanguage(this)
        if (verifiedInbox) current().channel.list()
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        languageChanged()
    }
    private var voiceForeground = false
    private var joinSent = false
    private var invitationObserver: (() -> Unit)? = null
    private val tokenState = TokenUpdates()
    @Volatile private var session: Session? = null
    private var observer: (() -> Unit)? = null
    private var recreatingUi = false
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
    private val joinTimeout = Runnable { if (call != null && !talking) endCall(DiagnosticEvent.END_JOIN_TIMEOUT, UiMessage(R.string.voice_did_not_become_ready_request_remains_pending)) }
    @Volatile private var call: CallService? = null
    internal val callId: String? get() = call?.id
    internal val callVisual: CallVisualSource? get() = call
    private var endingId: String? = null
    internal val idle get() = call == null && endingId == null
    internal var talking = false
        private set
    internal var verifiedInbox = false
        private set
    private var statusMessage = UiMessage(R.string.offline)
    internal val status get() = statusMessage.resolve(this)
    internal enum class InboxConnection { CONNECTING, REFRESHING, CONNECTED, DISCONNECTED }
    internal var inboxConnection = InboxConnection.DISCONNECTED
        private set
    internal var refreshing = false
        private set
    internal val canRefresh get() = observer != null && paired && !needsRelayOrigin && idle &&
        requestedJoin == null && submitting.isEmpty() && !pairing
    private val refreshTimeout = Runnable {
        finishRefresh()
        inboxConnection = InboxConnection.DISCONNECTED
        statusMessage = UiMessage(R.string.refresh_timed_out_pull_down_to_try_again)
        changed()
    }
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
    private val localFormMessages = mutableMapOf<String, Pair<Int, String>>()
    private fun setFormMessage(id: String, resource: Int) {
        val rendered = uiString(resource)
        localFormMessages[id] = resource to rendered
        formMessages[id] = rendered
    }
    internal fun formMessage(id: String): String? {
        val value = formMessages[id] ?: return null
        val local = localFormMessages[id]
        return if (local != null && local.second == value) uiString(local.first) else value
    }
    internal val submitting = mutableSetOf<String>()
    /** Last authenticated schema per question, kept after the tunnel retires so the shade can render it. */
    private val notificationForms = mutableMapOf<String, JSONObject>()
    internal val notificationStates = mutableMapOf<String, NotificationForm.State>()
    /** Drafts edited in the shade; an open in-app form must rebuild from them. */
    internal val externalDrafts = mutableSetOf<String>()
    /** Shade submissions waiting for an authenticated tunnel; never sent twice. */
    private val queuedAnswers = linkedMapOf<String, Pair<JSONObject, JSONArray>>()
    internal var answerReceipt: String? = null
        private set
    internal fun takeAnswerReceipt(): String? {
        val receipt = answerReceipt
        answerReceipt = null
        return receipt
    }
    private class FormLoad(val language: String)
    private val loadingForms = mutableMapOf<String, FormLoad>()
    private val awaitingReceipts = mutableSetOf<String>()

    internal fun loadForm(id: String) {
        if (!verifiedInbox || id !in store.state.pending || id in forms || id in formMessages || id in loadingForms) return
        val s = current()
        val load = FormLoad(AppLanguage.effective(this))
        loadingForms[id] = load
        s.channel.form(id)
        main.postDelayed({
            if (session === s && loadingForms[id] === load) {
                loadingForms.remove(id)
                setFormMessage(id, R.string.question_did_not_arrive_reconnect_to_refresh)
                settleSync(); changed()
            }
        }, 30_000)
    }

    internal fun answer(id: String, values: JSONObject, notes: JSONArray) {
        if (observer == null || !verifiedInbox || !idle || requestedJoin != null ||
            id !in forms || id !in store.state.pending || id in submitting) return
        acknowledge(id)
        answerReceipt = null
        submitting.add(id); setFormMessage(id, R.string.submitting)
        drafts[id] = values; noteDrafts[id] = notes
        send(id, values, notes)
    }

    internal fun notificationForm(id: String): JSONObject? =
        (notificationForms[id] ?: forms[id]?.takeIf { verifiedInbox })?.takeIf { id in store.state.pending }

    /** Silently re-render an existing question notification after shade or receipt changes. */
    internal fun refreshNotification(id: String) {
        val item = store.state.pending[id] ?: return
        if (id !in store.state.invited || id in store.state.silenced || id in store.state.acknowledged || id == callId) return
        Invites.show(this, id, item)
    }

    internal fun notificationDraftChanged(id: String) {
        externalDrafts.add(id)
        refreshNotification(id)
        changed() // Rebuild any open in-app form from the same draft immediately.
    }

    /** Submit from the notification shade, connecting in the background when needed. */
    internal fun answerFromNotification(id: String, values: JSONObject, notes: JSONArray) {
        drafts[id] = values; noteDrafts[id] = notes
        if (!idle || requestedJoin != null || id in submitting || id !in store.state.pending) { refreshNotification(id); return }
        answerReceipt = null
        submitting.add(id); setFormMessage(id, R.string.submitting)
        if (verifiedInbox) send(id, values, notes)
        else {
            queuedAnswers[id] = values to notes
            if (observer != null || syncJob != null) { if (!current().connecting) connect() }
            else SilenceJob.schedule(this, urgent = true)
            refreshNotification(id); changed()
        }
    }

    private fun send(id: String, values: JSONObject, notes: JSONArray) {
        awaitingReceipts.add(id)
        val s = current()
        if (!s.channel.answer(id, values, notes)) {
            submitting.remove(id)
            awaitingReceipts.remove(id)
            setFormMessage(id, R.string.answer_was_not_sent_check_the_connection_or_shorten_your)
            refreshNotification(id); changed(); return
        }
        main.postDelayed({
            if (session === s && id in submitting && localFormMessages[id]?.first == R.string.submitting) {
                setFormMessage(id, R.string.submission_not_confirmed_check_the_desktop_before_retrying)
                refreshNotification(id); changed()
            }
        }, 30_000)
        refreshNotification(id); changed()
    }

    private fun invalidateForms() {
        forms.clear(); loadingForms.clear()
        staleSubmittedForms.clear()
        awaitingReceipts.clear()
        formMessages.keys.retainAll(submitting)
        localFormMessages.keys.retainAll(submitting)
        // A queued shade answer was never sent; it may still go out on the next authenticated tunnel.
        for (id in submitting) if (id !in queuedAnswers) setFormMessage(id, R.string.submission_not_confirmed_check_the_desktop_before_retrying)
    }

    override fun onCreate() {
        super.onCreate()
        AppLanguage.initialize(this)
        DebugDiagnostics.initialize(this)
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
            statusMessage = UiMessage(R.string.audio_route_could_not_be_changed_previous_setting_kept)
        } else {
            audioSettings.speakerEnabled = enabled
        }
        changed()
    }

    internal fun foreground(render: () -> Unit, renderVoice: (() -> Unit)? = null, saveDrafts: (() -> Unit)? = null) {
        DebugDiagnostics.record(DiagnosticEvent.APP_FOREGROUND)
        recreatingUi = false
        observer = render; voiceObserver = renderVoice
        saveDraftObserver = saveDrafts
        val s = current()
        if (s.channel.isPaired() && !verifiedInbox && !s.connecting) connect()
        if (requestedJoin != null && verifiedInbox) s.channel.list()
        refreshToken()
        changed()
    }

    internal fun background(recreating: Boolean = false) {
        DebugDiagnostics.record(DiagnosticEvent.APP_BACKGROUND)
        observer = null; voiceObserver = null
        saveDraftObserver = null
        recreatingUi = recreating
        if (recreating) return
        requestedJoin = null
        if (!voiceForeground) endCall(DiagnosticEvent.END_BACKGROUND, null)
        if (call == null && (syncJob == null || pairing)) retire()
    }

    internal fun connect() {
        val s = current()
        if (!s.channel.isPaired()) return
        DebugDiagnostics.record(DiagnosticEvent.CONNECT_REQUESTED)
        s.connecting = true
        inboxConnection = InboxConnection.CONNECTING
        statusMessage = UiMessage(R.string.connecting_to_desktop)
        s.channel.connect(); changed()
    }

    internal fun retry() {
        DebugDiagnostics.record(DiagnosticEvent.CONNECT_RETRY)
        endCall(DiagnosticEvent.END_RECONNECT, null); retire(); statusMessage = UiMessage(R.string.offline); connect(); refreshToken(); changed()
    }

    internal fun refreshQuestions() {
        if (!canRefresh || refreshing) return
        if (!verifiedInbox) retry()
        refreshing = true
        if (verifiedInbox) inboxConnection = InboxConnection.REFRESHING
        main.postDelayed(refreshTimeout, 30_000)
        if (verifiedInbox) current().channel.list()
        changed()
    }

    private fun finishRefresh() {
        refreshing = false
        main.removeCallbacks(refreshTimeout)
    }

    private fun refreshToken() {
        if (BuildConfig.ISOLATED_INTEGRATION) return
        val lookup = tokenState.beginLookup()
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (tokenState.isCurrent(lookup)) {
                pushWarningMessage = null; current().channel.updateFcmToken(token); changed()
            }
        }.addOnFailureListener {
            if (tokenState.isCurrent(lookup)) { pushWarningMessage = UiMessage(R.string.push_registration_unavailable_reopen_the_inbox_to_retry); changed() }
        }
    }

    private var pushWarningMessage: UiMessage? = null
    internal val pushWarning get() = pushWarningMessage?.resolve(this)
    internal fun rotatedToken(token: String) {
        tokenState.rotated(); pushWarningMessage = null
        current().channel.updateFcmToken(token)
    }

    internal fun pair(raw: String) {
        if (observer == null || paired || pairing) return
        if (raw.isBlank() || raw.length > 8192) { statusMessage = UiMessage(R.string.invalid_pairing_code); changed(); return }
        pairing = true; statusMessage = UiMessage(R.string.verifying_desktop_identity)
        runCatching { current().channel.pair(raw) }.onFailure { pairing = false; statusMessage = UiMessage(R.string.invalid_pairing_code) }
        changed()
    }

    internal fun confirm(emoji: String, accept: Boolean) {
        if (observer == null || emoji != verifyEmoji) return
        verifyEmoji = null
        statusMessage = if (accept) UiMessage(R.string.waiting_for_desktop_approval) else UiMessage(R.string.pairing_declined)
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
        if (syncJob == null) SilenceJob.schedule(this, urgent = true)
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

    /** A background sync stays alive for shade forms and answer receipts it is responsible for. */
    private fun settleSync() {
        if (syncJob != null && queuedAnswers.isEmpty() && awaitingReceipts.isEmpty() && loadingForms.isEmpty()) finishSync(false)
    }

    private fun finishSync(retry: Boolean) {
        val done = syncJob ?: return
        syncJob = null; main.removeCallbacks(timeout)
        if (!retry) store.needsSync = false
        if (observer == null && call == null) retire()
        done(retry)
    }

    internal fun join(id: String) {
        DebugDiagnostics.record(DiagnosticEvent.JOIN_REQUESTED)
        acknowledge(id)
        if (observer == null || !validId(id)) { DebugDiagnostics.record(DiagnosticEvent.JOIN_REJECTED); return }
        if (id in submitting || forms[id]?.optBoolean("voice", true) == false) {
            DebugDiagnostics.record(DiagnosticEvent.JOIN_REJECTED)
            statusMessage = UiMessage(R.string.voice_is_unavailable_for_this_question_review_its_answer_on)
            changed(); return
        }
        if (!idle) { DebugDiagnostics.record(DiagnosticEvent.JOIN_REJECTED); statusMessage = UiMessage(R.string.end_the_current_call_before_answering_another_request); changed(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            DebugDiagnostics.record(DiagnosticEvent.JOIN_PERMISSION_DENIED)
            statusMessage = UiMessage(R.string.microphone_permission_is_required_nothing_was_joined); changed(); return
        }
        requestedJoin = id
        statusMessage = UiMessage(R.string.checking_that_this_request_is_still_pending)
        store.state.invalidateDetails()
        if (verifiedInbox) current().channel.list() else connect()
        changed()
    }

    private fun startCall(id: String) {
        val microphone = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (observer == null || !canJoin(store.state, id, verifiedInbox, idle, microphone)) {
            DebugDiagnostics.record(DiagnosticEvent.JOIN_REJECTED)
            statusMessage = UiMessage(R.string.unable_to_answer_here_open_away_and_check_microphone_permission); return
        }
        Invites.stopRinging(this)
        DebugDiagnostics.record(DiagnosticEvent.CALL_STARTED)
        val s = current()
        lateinit var media: CallService
        media = CallService(this, id, { pcm -> s.channel.sendPcm(pcm) }, { mark -> s.channel.played(id, mark) }, {
            main.post { if (call === media) endCall(DiagnosticEvent.END_AUDIO, UiMessage(R.string.audio_interrupted_request_remains_pending)) }
        }, {
            main.post {
                if (call === media && voiceForeground) {
                    main.removeCallbacks(joinTimeout); talking = true; statusMessage = UiMessage(R.string.in_call); changed()
                    DebugDiagnostics.record(DiagnosticEvent.CALL_READY)
                }
            }
        }, { active ->
            main.post {
                if (call === media && speaking != active) { speaking = active; voiceObserver?.invoke() }
            }
        })
        callLanguage = AppLanguage.effective(this)
        call = media; talking = false; voiceForeground = false; joinSent = false; statusMessage = UiMessage(R.string.starting_foreground_voice_call)
        speaking = false; callerCaption = ""; assistantCaption = ""
        callerCaptionFinal = false; assistantCaptionFinal = false
        Invites.cancel(this, id)
        main.postDelayed(joinTimeout, 90_000)
        DebugDiagnostics.record(DiagnosticEvent.FOREGROUND_REQUESTED)
        try { VoiceForegroundService.start(this, id) }
        catch (error: RuntimeException) {
            DebugDiagnostics.record(DiagnosticEvent.FOREGROUND_FAILED, error = error)
            voiceForegroundFailed(id)
        }
        changed()
    }

    internal fun voiceForegroundReady(id: String) {
        if (callId != id) return
        DebugDiagnostics.record(DiagnosticEvent.FOREGROUND_READY)
        voiceForeground = true; joinSent = true
        current().channel.join(id, callLanguage)
    }

    internal fun voiceForegroundFailed(id: String) {
        if (callId == id) endCall(DiagnosticEvent.END_FOREGROUND, UiMessage(R.string.android_could_not_keep_microphone_access_in_the_foreground_reopen))
    }

    internal fun hangup() = endCall(DiagnosticEvent.END_USER, UiMessage(R.string.call_ended_the_desktop_controls_the_pending_request))

    private fun endCall(reason: DiagnosticEvent, message: UiMessage?, tellDesktop: Boolean = true) {
        val media = call ?: return
        DebugDiagnostics.record(reason)
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
            DebugDiagnostics.record(DiagnosticEvent.HANGUP_SENT)
            session?.channel?.hangup(media.id)
        }
        if (message != null) statusMessage = message
        changed()
    }

    private fun retire() {
        finishRefresh()
        inboxConnection = InboxConnection.DISCONNECTED
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
        DebugDiagnostics.record(DiagnosticEvent.INBOX_RECEIVED, items.size)
        finishRefresh()
        val channel = current().channel
        val removed = store.reconcile(items.map { Pending(it.requestId, it.project, it.question, it.createdAt, it.session, it.call) })
        for (id in removed) {
            staleSubmittedForms.remove(id)
            notificationForms.remove(id); notificationStates.remove(id); externalDrafts.remove(id); queuedAnswers.remove(id)
            forms.remove(id); drafts.remove(id); noteDrafts.remove(id)
            loadingForms.remove(id); formMessages.remove(id); localFormMessages.remove(id)
        }
        submitting.removeAll(removed)
        for (id in removed) Invites.cancel(this, id)
        verifiedInbox = true; sentSilences.removeAll(removed)
        inboxConnection = InboxConnection.CONNECTED
        // Consume fresh call tokens before forwarding old silences; an earlier "Not now"
        // must not immediately decline a new explicit call.
        val incoming = if (idle) store.state.pending.values.filter { it.id !in submitting && store.ring(it) }.map { it.id }.toSet()
            else emptySet()
        sentSilences.removeAll(incoming)
        val toSilence = store.state.silenced.filter { sentSilences.add(it) }
        toSilence.forEach { channel.silence(it) }
        if (callId?.let { it !in store.state.pending } == true) endCall(DiagnosticEvent.END_QUESTION_REMOVED, UiMessage(R.string.request_closed_on_desktop))
        else if (call == null) statusMessage = UiMessage(R.string.connected_to_desktop)
        val answer = requestedJoin
        if (answer != null && observer != null) {
            requestedJoin = null
            if (answer in store.state.pending) startCall(answer)
            else statusMessage = UiMessage(R.string.that_request_is_no_longer_pending_nothing_was_joined)
        }
        for ((id, answer) in queuedAnswers.toList()) {
            queuedAnswers.remove(id)
            if (id in store.state.pending && idle) send(id, answer.first, answer.second)
            else { submitting.remove(id); setFormMessage(id, R.string.answer_was_not_sent_check_the_connection_or_shorten_your) }
        }
        for (item in store.state.pending.values) {
            if (item.call == null) Invites.cancelRinging(this, item.id)
            // Only an explicit desktop call rings, once per call token.
            if (item.id in incoming) {
                Invites.show(this, item.id, item, alert = true, call = true)
                continue
            }
            val alert = store.consumeAlert(item.id)
            if (item.id in store.state.invited && item.id !in store.state.silenced && item.id !in store.state.acknowledged && item.id != callId) {
                Invites.show(this, item.id, item, alert, !idle)
                if (inviteSettings.showPreview && item.id !in notificationForms) loadForm(item.id)
            }
        }
        store.needsSync = false
        if (syncJob != null) {
            // A list response following silence fences its delivery on this ordered socket.
            if (toSilence.isNotEmpty()) channel.list() else settleSync()
        }
        changed()
    }

    private inner class Session : PairedChannel.Listener {
        val channel = PairedChannel(this@Gateway, this)
        var connecting = false
        @Volatile private var stream: CallService? = null
        private fun ui(action: () -> Unit) { main.post { if (session === this) action() } }

        override fun onVerify(emoji: String) = ui {
            if ((observer != null || recreatingUi) && pairing) { verifyEmoji = emoji; changed() } else retire()
        }

        override fun onReady() = ui {
            pairing = false; verifyEmoji = null; connecting = false; verifiedInbox = false
            inboxConnection = InboxConnection.REFRESHING
            statusMessage = UiMessage(R.string.refreshing_inbox); changed()
        }

        override fun onInbox(items: List<InboxItem>) = ui { reconcileInbox(items) }

        override fun onForm(requestId: String, form: JSONObject?, language: String?) = ui {
            val load = loadingForms.remove(requestId)
            if (!verifiedInbox || requestId !in store.state.pending) { settleSync(); return@ui }
            if ((language ?: load?.language)?.let { it != AppLanguage.effective(this@Gateway) } == true) {
                // The old reply releases the desktop's outstanding-request correlation.
                if (localFormMessages[requestId]?.first == R.string.question_did_not_arrive_reconnect_to_refresh) {
                    localFormMessages.remove(requestId)
                    formMessages.remove(requestId)
                }
                loadForm(requestId)
                return@ui
            }
            staleSubmittedForms.remove(requestId)
            if (form != null) {
                forms[requestId] = form
                notificationForms[requestId] = form
                if (requestId !in submitting) formMessages.remove(requestId)
            } else {
                forms.remove(requestId)
                notificationForms.remove(requestId)
                if (requestId !in submitting)
                    setFormMessage(requestId, R.string.touch_answers_are_unavailable_for_this_question_review_details_or)
            }
            refreshNotification(requestId)
            settleSync()
            changed()
        }

        override fun onAnswer(requestId: String, status: String, message: String) = ui {
            DebugDiagnostics.record(DiagnosticEvent.ANSWER_RECEIVED)
            if (!awaitingReceipts.remove(requestId)) return@ui
            // An uncertain delivery is never automatically retried, including across reconnects.
            if (status == "invalid" || status == "busy") submitting.remove(requestId)
            localFormMessages.remove(requestId)
            if (requestId in store.state.pending) formMessages[requestId] = message
            this@Gateway.statusMessage = UiMessage(text = message)
            answerReceipt = message
            if ((status == "invalid" || status == "busy") && staleSubmittedForms.remove(requestId)) {
                forms.remove(requestId)
                formMessages.remove(requestId)
            }
            if (status == "accepted" || status == "stale") {
                forms.remove(requestId); drafts.remove(requestId); noteDrafts.remove(requestId)
                notificationForms.remove(requestId); notificationStates.remove(requestId)
                staleSubmittedForms.remove(requestId)
                Invites.cancel(this@Gateway, requestId)
                if (observer == null && status == "accepted") Invites.receipt(this@Gateway, requestId, message)
                channel.list()
            } else refreshNotification(requestId)
            settleSync()
            changed()
        }

        override fun onQuestion(requestId: String, display: QuestionDisplay?) = ui {
            if (verifiedInbox && store.state.question(requestId, display)) changed()
        }

        override fun onProposal(requestId: String, text: String) = ui {
            if (verifiedInbox && callId == requestId && store.state.proposal(requestId, text)) changed()
        }

        override fun onJoined(requestId: String) {
            DebugDiagnostics.record(DiagnosticEvent.REMOTE_JOINED)
            val media = call?.takeIf { it.id == requestId && session === this }
            stream = media
            ui {
                if (media != null && call === media && voiceForeground && verifiedInbox && requestId in store.state.pending) {
                    statusMessage = UiMessage(R.string.waiting_for_the_desktop_s_voice)
                    media.start(); changed()
                } else {
                    DebugDiagnostics.record(DiagnosticEvent.REMOTE_JOIN_REJECTED)
                    channel.hangup(requestId)
                }
            }
        }
        override fun onPcm(pcm: ByteArray) { stream?.receive(pcm) }
        override fun onMark(requestId: String, mark: String) { stream?.takeIf { it.id == requestId }?.mark(mark) }
        override fun onTranscript(requestId: String, role: String, text: String, final: Boolean) = ui {
            if (callId != requestId) return@ui
            call?.transcript(role, text, final)
            if (role == "user") { callerCaption = text; callerCaptionFinal = final }
            else { assistantCaption = text; assistantCaptionFinal = final }
            voiceObserver?.invoke()
        }
        override fun onEnded(requestId: String) {
            stream?.takeIf { it.id == requestId }?.let { stream = null; it.invalidate() }
            ui {
                if (endingId == requestId) endingId = null
                if (callId == requestId) endCall(DiagnosticEvent.END_DESKTOP, UiMessage(R.string.call_ended_by_desktop), false)
                if (observer == null && syncJob == null) retire() else channel.list()
            }
        }
        override fun onError(code: String) = ui {
            DebugDiagnostics.transportFailure(code)
            if (code == "push_token_unavailable" || code == "push_token_rejected") {
                pushWarningMessage = UiMessage(R.string.push_registration_unavailable_reopen_the_inbox_to_retry)
                changed(); return@ui
            }
            finishRefresh()
            inboxConnection = InboxConnection.DISCONNECTED
            requestedJoin = null
            verifiedInbox = false; store.state.invalidateDetails()
            invalidateForms()
            endCall(DiagnosticEvent.END_TRANSPORT_ERROR, null); verifyEmoji = null; pairing = false; connecting = false
            statusMessage = when (code) {
                "relay_origin_required" -> UiMessage(R.string.relay_setup_required_pairing_keys_have_been_retained)
                "relay_origin_rejected" -> UiMessage(R.string.enter_a_valid_https_relay_origin_without_credentials_path_query)
                "inbox-too-large" -> UiMessage(R.string.desktop_inbox_is_too_large_to_synchronize_requests_remain_pending)
                "inbox-unavailable" -> UiMessage(R.string.desktop_inbox_is_not_yet_available_pending_sync_cached_details)
                else -> UiMessage(R.string.connection_error, argument = code.takeIf { it.matches(Regex("[a-zA-Z0-9_-]{1,64}")) }.orEmpty())
            }
            changed()
        }
        override fun onDisconnected() {
            DebugDiagnostics.record(DiagnosticEvent.TRANSPORT_CLOSED)
            val media = stream; stream = null; media?.invalidate()
            ui {
                finishRefresh()
                inboxConnection = InboxConnection.DISCONNECTED
                endCall(DiagnosticEvent.END_TRANSPORT_LOST, null, false); verifiedInbox = false; verifyEmoji = null; pairing = false; connecting = false; sentSilences.clear()
                store.state.invalidateDetails()
                invalidateForms()
                endingId = null
                if (statusMessage.resource != R.string.connection_error) statusMessage = UiMessage(R.string.disconnected_showing_cached_inbox)
                changed()
            }
        }
    }
}
