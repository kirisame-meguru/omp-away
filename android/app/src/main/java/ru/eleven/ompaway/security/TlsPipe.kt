package ru.eleven.ompaway.security

import java.io.EOFException
import java.nio.ByteBuffer
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngineResult
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManager

// Single-owner state: WSS message boundaries, inner TLS records and app frames are unrelated.
internal class TlsPipe(
    private val identity: PhoneIdentity,
    private val desktopPin: String,
    private val cipherOut: (ByteBuffer) -> Unit,
    private val opened: () -> Unit,
    private val plainIn: (ByteBuffer) -> Unit,
) {
    private val engine = SSLContext.getInstance("TLSv1.3").apply {
        init(arrayOf<KeyManager>(identity.manager()), arrayOf<TrustManager>(PinnedServer(desktopPin)), null)
    }.createSSLEngine().apply { useClientMode = true; enabledProtocols = arrayOf("TLSv1.3") }
    private val packet = ByteBuffer.allocate(engine.session.packetBufferSize)
    private val cipherIn = ByteBuffer.allocate(engine.session.packetBufferSize * 2)
    private val plain = ByteBuffer.allocate(engine.session.applicationBufferSize)
    private val empty = ByteBuffer.allocate(0)
    private var authenticated = false

    fun start() { engine.beginHandshake(); drive() }

    fun receive(bytes: ByteBuffer) {
        require(bytes.hasRemaining())
        val limit = bytes.limit()
        while (bytes.hasRemaining()) {
            val count = minOf(cipherIn.remaining(), bytes.remaining())
            if (count == 0) throw SSLException("TLS record exceeds limit")
            bytes.limit(bytes.position() + count); cipherIn.put(bytes); bytes.limit(limit)
            drive()
        }
    }

    private fun finish(result: SSLEngineResult) {
        if (!authenticated && result.handshakeStatus == SSLEngineResult.HandshakeStatus.FINISHED) {
            val session = engine.session
            val peer = session.peerCertificates.firstOrNull() as? X509Certificate
            val local = session.localCertificates?.firstOrNull() as? X509Certificate
            if (session.protocol != "TLSv1.3" || peer == null || pinOf(peer) != desktopPin || local == null || pinOf(local) != identity.pin)
                throw SSLException("Missing mutual TLS identities")
            authenticated = true
            opened()
        }
    }

    private fun wrap(src: ByteBuffer): SSLEngineResult {
        packet.clear()
        val r = engine.wrap(src, packet)
        if (r.status != SSLEngineResult.Status.OK) throw SSLException("Cannot write TLS record")
        packet.flip()
        if (packet.hasRemaining()) cipherOut(packet)
        finish(r)
        return r
    }

    private fun drive() {
        while (true) {
            when (engine.handshakeStatus) {
                SSLEngineResult.HandshakeStatus.NEED_TASK -> {
                    val task = engine.delegatedTask ?: throw SSLException("Missing TLS task")
                    task.run()
                }
                SSLEngineResult.HandshakeStatus.NEED_WRAP -> {
                    val r = wrap(empty)
                    if (r.bytesProduced() == 0 && engine.handshakeStatus == SSLEngineResult.HandshakeStatus.NEED_WRAP) throw SSLException("TLS write stalled")
                }
                else -> {
                    if (cipherIn.position() == 0 && engine.handshakeStatus.name != "NEED_UNWRAP_AGAIN") return
                    cipherIn.flip(); plain.clear()
                    val oldStatus = engine.handshakeStatus
                    val r = engine.unwrap(cipherIn, plain)
                    cipherIn.compact()
                    when (r.status) {
                        SSLEngineResult.Status.CLOSED -> throw EOFException("TLS closed")
                        SSLEngineResult.Status.BUFFER_UNDERFLOW -> return
                        SSLEngineResult.Status.OK -> Unit
                        else -> throw SSLException("TLS plaintext exceeds limit")
                    }
                    finish(r)
                    plain.flip()
                    if (plain.hasRemaining()) { check(authenticated); plainIn(plain) }
                    if (r.bytesConsumed() == 0 && r.bytesProduced() == 0 && oldStatus == engine.handshakeStatus) throw SSLException("TLS read stalled")
                }
            }
        }
    }

    fun send(frame: ByteBuffer) {
        check(authenticated)
        while (frame.hasRemaining()) {
            val r = wrap(frame)
            if (r.bytesConsumed() == 0) throw SSLException("TLS application write stalled")
        }
    }
}

internal class FrameDecoder(private val onFrame: (Int, ByteArray) -> Unit) {
    private val header = ByteBuffer.allocate(5)
    private var kind = 0
    private var payload: ByteBuffer? = null
    fun receive(src: ByteBuffer) {
        while (src.hasRemaining()) {
            val body = payload
            val dst = body ?: header
            val count = minOf(src.remaining(), dst.remaining())
            val limit = src.limit()
            src.limit(src.position() + count); dst.put(src); src.limit(limit)
            if (dst.hasRemaining()) continue
            if (body == null) {
                header.flip(); kind = header.get().toInt(); val length = header.int; header.clear()
                require((kind == 1 && length in 1..65536) || (kind == 2 && length == 960))
                payload = ByteBuffer.allocate(length)
            } else {
                payload = null
                onFrame(kind, body.array())
            }
        }
    }
}

internal fun frame(kind: Int, payload: ByteArray): ByteBuffer = ByteBuffer.allocate(5 + payload.size).apply {
    require((kind == 1 && payload.size in 1..65536) || (kind == 2 && payload.size == 960))
    put(kind.toByte()); putInt(payload.size); put(payload); flip()
}
