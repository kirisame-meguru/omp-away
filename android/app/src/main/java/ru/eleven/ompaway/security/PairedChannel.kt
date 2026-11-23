package ru.eleven.ompaway.security

import android.content.Context
import java.io.Closeable
import java.io.EOFException
import java.io.IOException
import java.security.cert.CertificateException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import ru.eleven.ompaway.QuestionDisplay
import ru.eleven.ompaway.decodeQuestionDisplay

data class InboxItem(val requestId: String, val project: String, val question: String, val createdAt: Long, val session: String? = null)

/** One application-owned instance. Listener callbacks are serialized, off the main thread. */
class PairedChannel(context: Context, private val listener: Listener) : Closeable {
    interface Listener {
        fun onVerify(emoji: String) {}
        fun onReady() {}
        fun onInbox(items: List<InboxItem>) {}
        fun onQuestion(requestId: String, display: QuestionDisplay?) {}
        fun onProposal(requestId: String, text: String) {}
        fun onJoined(requestId: String) {}
        fun onEnded(requestId: String) {}
        fun onPcm(pcm: ByteArray) {}
        fun onMark(requestId: String, mark: String) {}
        fun onTranscript(requestId: String, role: String, text: String, final: Boolean) {}
        fun onError(code: String) {}
        fun onDisconnected() {}
    }

    private class Voice(val id: String) {
        var joined = false
        var stopping = false
        val marks = ArrayDeque<String>()
    }
    private class Session(val identity: PhoneIdentity, var invite: Invitation?, var route: Route?) {
        var gate: EnrollmentGate? = invite?.let { EnrollmentGate(fingerprint(digestBytes(it.desktop), digestBytes(identity.pin), digestBytes(it.nonce))) }
        var ws: WebSocket? = null
        var enroll: Call? = null
        var timeout: ScheduledFuture<*>? = null
        var tls: TlsPipe? = null
        var voice: Voice? = null
        val pendingIds = HashSet<String>()
    }

    private val vault = Vault(context.applicationContext)
    private val worker = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "away-channel") }.apply { removeOnCancelPolicy = true }
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(25, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()
    private val closed = AtomicBoolean()
    private var wanted = false
    private var session: Session? = null
    @Volatile private var ready: Session? = null
    @Volatile private var recording: Voice? = null
    private val captureQueue = AtomicInteger()
    private var retry: ScheduledFuture<*>? = null
    private var failures = 0
    private var tokenCall: Call? = null
    private var tokenRetry: ScheduledFuture<*>? = null
    private var lastToken: String? = null
    private var tokenFailures = 0
    private val details = DetailsNegotiation()

    fun isPaired(): Boolean = vault.paired()
    fun needsRelayOrigin(): Boolean = vault.paired() && runCatching { vault.route()?.origin == null }.getOrDefault(false)
    fun migrateRelayOrigin(origin: String) = post {
        try { vault.migrateOrigin(origin); wanted = true; restore(); refreshToken() }
        catch (_: Exception) { listener.onError("relay_origin_rejected") }
    }

    private fun post(block: () -> Unit) {
        if (closed.get()) return
        try { worker.execute { if (!closed.get()) block() } } catch (_: RejectedExecutionException) { }
    }
    private fun current(s: Session, block: () -> Unit) {
        if (s !== session || closed.get()) return
        try { block() }
        catch (_: EOFException) { loss(s, "tunnel_closed", true) }
        catch (_: Exception) { loss(s, "secure_channel_rejected", false) }
    }
    private fun timeout(s: Session, seconds: Long, retryable: Boolean) {
        s.timeout?.cancel(false)
        s.timeout = worker.schedule({ if (s === session) loss(s, "tunnel_timeout", retryable) }, seconds, TimeUnit.SECONDS)
    }
    private fun cleanup() {
        val s = session ?: return
        ready = null; recording = null; session = null
        s.gate?.cancel(); s.gate = null; s.invite = null; s.timeout?.cancel(false)
        s.enroll?.cancel(); s.ws?.cancel(); s.tls = null; s.voice = null; s.route = null
        listener.onDisconnected()
    }
    private fun loss(s: Session, code: String, retryable: Boolean) {
        if (s !== session) return
        val fallback = details.retryLegacy(ready === s)
        val reconnect = (retryable || fallback) && wanted && s.invite == null && vault.paired()
        if (!reconnect) wanted = false
        cleanup(); listener.onError(code)
        if (reconnect && !closed.get()) {
            val delay = 1L shl minOf(failures, 5)
            failures = minOf(failures + 1, 5)
            retry = worker.schedule({ retry = null; if (wanted && !closed.get()) restore() }, delay, TimeUnit.SECONDS)
        }
    }

    fun disconnect() = post {
        wanted = false; retry?.cancel(false); retry = null; cleanup()
    }
    fun connect() = post {
        if (session == null && retry == null) { wanted = true; restore() }
    }
    private fun restore() {
        try {
            val route = vault.route() ?: error("Not paired")
            if (route.origin == null) { wanted = false; listener.onError("relay_origin_required"); return }
            val identity = PhoneIdentity.open(IDENTITY, false)
            check(route.phonePin == identity.pin)
            val s = Session(identity, null, route); session = s
            current(s) { tunnel(s) }; refreshToken()
        } catch (_: Exception) { wanted = false; cleanup(); listener.onError("pairing_unavailable") }
    }

    fun pair(qrJson: String) = post {
        if (session != null || vault.paired()) { listener.onError("already_pairing_or_paired"); return@post }
        try {
            val invite = Invitation.parse(qrJson)
            val identity = PhoneIdentity.open(IDENTITY, true)
            val s = Session(identity, invite, null); session = s
            val req = Request.Builder().url("${invite.origin}/v1/enroll").post(jsonBody(JSONObject().put("ticket", invite.ticket))).build()
            val call = http.newCall(req); s.enroll = call
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = post { loss(s, "enrollment_failed", false) }
                override fun onResponse(call: Call, response: Response) {
                    val route = try { response.use {
                        require(it.isSuccessful)
                        val src = it.body?.source() ?: error("Missing enrollment")
                        require(!src.request(8193))
                        bytesJson(src.readByteArray()).run {
                            fields("deviceId", "token")
                            Route(text("deviceId"), text("token"), invite.desktop, identity.pin, invite.origin)
                        }
                    } } catch (_: Exception) { post { loss(s, "enrollment_rejected", false) }; return }
                    post { current(s) { s.enroll = null; s.route = route; tunnel(s) } }
                }
            })
        } catch (_: Exception) { cleanup(); listener.onError("invalid_pairing") }
    }

    fun confirmPair(emoji: String, accept: Boolean) = post {
        val s = session ?: return@post
        val gate = s.gate ?: return@post
        if (gate.emoji != emoji) return@post // A dialog from a different attempt has no authority.
        current(s) {
            if (!accept) { loss(s, "pairing_cancelled", false); return@current }
            gate.accept(emoji)
            sendJson(s, JSONObject().put("type", "verify").put("accept", true))
        }
    }

    private fun tunnel(s: Session) {
        val route = checkNotNull(s.route)
        timeout(s, 35, true)
        val req = Request.Builder().url("${checkNotNull(route.origin)}/v1/phone").header("Authorization", "Bearer ${route.token}").build()
        s.ws = http.newWebSocket(req, object : WebSocketListener() {
            private val backlog = AtomicInteger()
            private val messages = AtomicInteger()
            private val stopped = AtomicBoolean()
            private fun reject(ws: WebSocket) {
                if (stopped.compareAndSet(false, true)) { post { loss(s, "invalid_tunnel", false) }; ws.cancel() }
            }
            override fun onOpen(webSocket: WebSocket, response: Response) = post { current(s) {
                val decoder = FrameDecoder { kind, bytes -> incoming(s, kind, bytes) }
                val tls = TlsPipe(s.identity, route.desktopPin, { bytes ->
                    check(webSocket.queueSize() + bytes.remaining() <= 24 * 1024 && webSocket.send(bytes.toByteString()))
                }, {
                    val invite = s.invite
                    if (invite == null) activate(s) else {
                        timeout(s, 600, false)
                        sendJson(s, JSONObject().put("type", "pair").put("nonce", invite.nonce).put("secret", invite.secret))
                    }
                }, decoder::receive)
                s.tls = tls; tls.start()
            } }
            override fun onMessage(webSocket: WebSocket, text: String) = reject(webSocket)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (stopped.get() || closed.get()) return
                if (bytes.size !in 1..262144 || messages.incrementAndGet() > 128 || backlog.addAndGet(bytes.size) > 524288) { reject(webSocket); return }
                post {
                    try { current(s) { checkNotNull(s.tls).receive(bytes.asByteBuffer()) } }
                    finally { messages.decrementAndGet(); backlog.addAndGet(-bytes.size) }
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null); post { loss(s, "tunnel_closed", true) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = post { loss(s, "tunnel_closed", true) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (stopped.get()) return
                val status = response?.code
                val retryable = t !is SSLException && t !is CertificateException && (status == null || status >= 500 || status == 429)
                post { loss(s, if (retryable) "tunnel_unavailable" else "relay_rejected", retryable) }
            }
        })
    }

    private fun activate(s: Session) {
        s.timeout?.cancel(false); s.timeout = null
        ready = s; wanted = true; failures = 0
        sendJson(s, listMessage()); listener.onReady()
    }
    private fun sendJson(s: Session, obj: JSONObject) = checkNotNull(s.tls).send(frame(1, obj.toString().toByteArray()))
    private fun incoming(s: Session, kind: Int, bytes: ByteArray) {
        check(s === session)
        if (kind == 2) {
            val voice = checkNotNull(s.voice); check(ready === s && voice.joined)
            if (!voice.stopping) listener.onPcm(bytes)
            return
        }
        val msg = bytesJson(bytes)
        val type = msg.text("type")
        val gate = s.gate
        if (gate != null) {
            when (type) {
                "verify" -> { msg.fields("type", "emoji"); gate.verify(msg.text("emoji")); listener.onVerify(gate.emoji) }
                "paired" -> {
                    msg.fields("type"); gate.paired(); vault.save(checkNotNull(s.route)); s.gate = null; s.invite = null
                    activate(s); refreshToken()
                }
                else -> error("Invalid enrollment message")
            }
            return
        }
        check(s === ready)
        when (type) {
            "inbox" -> {
                val snapshot = decodeInboxSnapshot(msg)
                s.pendingIds.clear()
                for (item in snapshot) s.pendingIds.add(item.requestId)
                listener.onInbox(snapshot)
            }
            "question" -> {
                msg.fields("type", "requestId", "display")
                val id = msg.text("requestId")
                details.receivedDetails()
                // A late detail must never resurrect a retired request or cross request boundaries.
                if (id in s.pendingIds) listener.onQuestion(id, decodeQuestionDisplay(msg.optJSONObject("display")))
            }
            "proposal" -> {
                msg.fields("type", "requestId", "text")
                val id = msg.text("requestId"); val text = msg.get("text") as String
                require(text.length <= 8192 && '\u0000' !in text)
                if (id in s.pendingIds) listener.onProposal(id, text)
            }
            "joined" -> {
                msg.fields("type", "requestId"); val v = checkNotNull(s.voice); check(!v.joined && v.id == msg.text("requestId"))
                v.joined = true; if (!v.stopping) { recording = v; listener.onJoined(v.id) }
            }
            "ended" -> {
                msg.fields("type", "requestId"); val id = msg.text("requestId")
                if (s.voice?.id == id) { recording = null; s.voice = null }
                listener.onEnded(id)
            }
            "mark" -> {
                msg.fields("type", "requestId", "mark"); val v = checkNotNull(s.voice)
                check(v.joined && v.id == msg.text("requestId"))
                if (!v.stopping) {
                    val mark = msg.text("mark"); check(v.marks.size < 64 && mark !in v.marks)
                    v.marks.addLast(mark); listener.onMark(v.id, mark)
                }
            }
            "transcript" -> {
                msg.fields("type", "requestId", "role", "text", "final")
                val v = checkNotNull(s.voice)
                check(v.joined && v.id == msg.text("requestId"))
                val role = msg.text("role")
                val text = msg.text("text")
                val final = msg.get("final") as Boolean
                require((role == "user" || role == "assistant") && text.length <= 8192 && '\u0000' !in text)
                if (!v.stopping) listener.onTranscript(v.id, role, text, final)
            }
            "error" -> {
                msg.fields("type", "code"); val code = msg.text("code")
                if (s.voice?.joined == false) s.voice = null
                listener.onError(code)
            }
            else -> error("Invalid desktop message")
        }
    }

    private fun action(block: (Session) -> Unit) {
        val s = ready ?: return
        post { current(s) { if (s === ready) block(s) } }
    }
    private fun listMessage() = JSONObject().put("type", "list").apply { if (details.enabled) put("details", true) }
    fun list() = action { sendJson(it, listMessage()) }
    fun join(requestId: String) = action { s ->
        if (requestId.isNotEmpty() && s.voice == null) { s.voice = Voice(requestId); command(s, "join", requestId, captions = true) }
    }
    fun silence(requestId: String) = action { s -> if (requestId.isNotEmpty()) command(s, "silence", requestId) }
    fun hangup(requestId: String) = action { s ->
        val v = s.voice
        if (v != null && v.id == requestId && !v.stopping) { recording = null; v.stopping = true; command(s, "hangup", requestId) }
    }
    private fun command(s: Session, type: String, id: String, captions: Boolean = false) = sendJson(s, JSONObject().put("type", type).put("requestId", id).apply {
        if (captions) put("captions", true)
    })
    fun played(requestId: String, mark: String) {
        val v = recording ?: return
        action { s -> if (v === recording && v.id == requestId && v.marks.firstOrNull() == mark) {
            v.marks.removeFirst(); sendJson(s, JSONObject().put("type", "played").put("requestId", requestId).put("mark", mark))
        } }
    }
    fun sendPcm(pcm: ByteArray) {
        require(pcm.size == 960)
        val v = recording ?: return
        val s = ready ?: return
        if (captureQueue.incrementAndGet() > 10) {
            captureQueue.decrementAndGet()
            post { if (v === recording) loss(s, "audio_backpressure", true) }; return
        }
        val out = frame(2, pcm) // synchronous snapshot: AudioRecord may reuse its buffer immediately.
        post {
            try { current(s) { if (v === recording) checkNotNull(s.tls).send(out) } }
            finally { captureQueue.decrementAndGet() }
        }
    }

    fun updateFcmToken(token: String) = post {
        try { require(token.isNotBlank() && token.length <= 8192); vault.setFcm(token); refreshToken() }
        catch (_: Exception) { listener.onError("push_token_unavailable") }
    }
    private fun refreshToken() {
        if (tokenCall != null || closed.get()) return
        val route: Route; val token: String
        try { route = vault.route() ?: return; token = vault.fcm() ?: return }
        catch (_: Exception) { listener.onError("push_token_unavailable"); return }
        val origin = route.origin ?: return
        if (token == lastToken) return
        tokenRetry?.cancel(false); tokenRetry = null
        val request = Request.Builder().url("$origin/v1/token").header("Authorization", "Bearer ${route.token}")
            .put(jsonBody(JSONObject().put("fcmToken", token))).build()
        val call = http.newCall(request); tokenCall = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = done(false, e !is SSLException)
            override fun onResponse(call: Call, response: Response) = response.use { done(it.code == 204, it.code >= 500 || it.code == 429) }
            private fun done(success: Boolean, retryable: Boolean) = post {
                tokenCall = null
                if (success) { lastToken = token; tokenFailures = 0; refreshToken() }
                else {
                    listener.onError("push_token_rejected")
                    lastToken = null
                    val rotated = try { vault.fcm() != token } catch (_: Exception) { false }
                    if (rotated) { refreshToken(); return@post }
                    if (retryable) {
                        val delay = 1L shl minOf(tokenFailures, 6); tokenFailures = minOf(tokenFailures + 1, 6)
                        tokenRetry = worker.schedule({ refreshToken() }, delay, TimeUnit.SECONDS)
                    }
                }
            }
        })
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        worker.execute {
            wanted = false; retry?.cancel(false); tokenRetry?.cancel(false); tokenCall?.cancel(); cleanup()
            http.dispatcher.cancelAll(); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown(); worker.shutdown()
        }
    }
    private companion object {
        const val IDENTITY = "away.handset.p256.v1"
        val JSON = "application/json; charset=utf-8".toMediaType()
        fun jsonBody(obj: JSONObject) = obj.toString().toRequestBody(JSON)
    }
}
