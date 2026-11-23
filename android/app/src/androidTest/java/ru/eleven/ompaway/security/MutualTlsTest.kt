package ru.eleven.ompaway.security

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.Principal
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager
import org.junit.Assert.*
import org.junit.Test

class MutualTlsTest {
    @Test fun throughUntrustedByteCarrierOnlyOriginalKeysCanExchangePlaintext() {
        val aliases = List(3) { "away.test.${UUID.randomUUID()}" }
        try {
            val (desktop, phone, stranger) = aliases.map { PhoneIdentity.open(it, true) }
            exchange(desktop, phone, desktop.pin, phone.pin, true)
            assertTrue("Substituted desktop", runCatching { exchange(stranger, phone, desktop.pin, phone.pin, true) }.isFailure)
            assertTrue("Substituted phone", runCatching { exchange(desktop, stranger, desktop.pin, phone.pin, true) }.isFailure)
            assertTrue("Server skipped client authentication", runCatching { exchange(desktop, phone, desktop.pin, phone.pin, false) }.isFailure)
        } finally {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); aliases.forEach { deleteEntry(it) } }
        }
    }

    private fun exchange(desktop: PhoneIdentity, phone: PhoneIdentity, desktopPin: String, expectedPhone: String, mutual: Boolean) {
        val manager = object : X509ExtendedKeyManager() {
            override fun chooseServerAlias(type: String?, issuers: Array<out Principal>?, socket: Socket?) = desktop.alias.takeIf { type == "EC" }
            override fun getServerAliases(type: String?, issuers: Array<out Principal>?) = if (type == "EC") arrayOf(desktop.alias) else null
            override fun getCertificateChain(alias: String?) = arrayOf(desktop.certificate).takeIf { alias == desktop.alias }
            override fun getPrivateKey(alias: String?) = desktop.key.takeIf { alias == desktop.alias }
            override fun getClientAliases(type: String?, issuers: Array<out Principal>?): Array<String>? = null
            override fun chooseClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? = null
            override fun chooseEngineServerAlias(type: String?, issuers: Array<out Principal>?, engine: javax.net.ssl.SSLEngine?) = chooseServerAlias(type, issuers, null)
        }
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = PinnedServer(expectedPhone).checkServerTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) { error("Unexpected server check") }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLSv1.3").apply { init(arrayOf<KeyManager>(manager), arrayOf<TrustManager>(trust), null) }
        val address = InetAddress.getLoopbackAddress()
        val sentinel = "private-message-${UUID.randomUUID()}".toByteArray()
        val executor = Executors.newSingleThreadExecutor()
        try {
            (context.serverSocketFactory.createServerSocket(0, 1, address) as SSLServerSocket).use { server ->
                server.enabledProtocols = arrayOf("TLSv1.3"); server.needClientAuth = mutual; server.soTimeout = 8000
                val receivedEcho = java.util.concurrent.CountDownLatch(1)
                val echo = executor.submit<Unit> {
                    (server.accept() as SSLSocket).use { peer ->
                        peer.soTimeout = 8000; peer.startHandshake()
                        val received = ByteArray(sentinel.size)
                        java.io.DataInputStream(peer.inputStream).readFully(received)
                        assertArrayEquals(sentinel, received)
                        peer.outputStream.write(received); peer.outputStream.flush()
                        check(receivedEcho.await(8, TimeUnit.SECONDS))
                    }
                }
                Socket(address, server.localPort).use { wire ->
                    val encrypted = ByteArrayOutputStream(); val plain = ByteArrayOutputStream()
                    wire.soTimeout = 8000
                    lateinit var tls: TlsPipe
                    tls = TlsPipe(phone, desktopPin, { packet ->
                        val bytes = ByteArray(packet.remaining()).also { packet.get(it) }
                        encrypted.write(bytes); wire.getOutputStream().write(bytes)
                    },
                        { tls.send(ByteBuffer.wrap(sentinel)) }, { b -> plain.write(ByteArray(b.remaining()).also { b.get(it) }) })
                    tls.start()
                    val fragment = ByteArray(211)
                    while (plain.size() < sentinel.size) {
                        val count = wire.getInputStream().read(fragment); check(count > 0) { "Peer closed before authenticated echo" }
                        encrypted.write(fragment, 0, count)
                        tls.receive(ByteBuffer.wrap(fragment, 0, count))
                    }
                    receivedEcho.countDown()
                    assertArrayEquals(sentinel, plain.toByteArray())
                    assertFalse(encrypted.toString("ISO-8859-1").contains(String(sentinel, Charsets.US_ASCII)))
                }
                echo.get(8, TimeUnit.SECONDS)
            }
        } finally { executor.shutdownNow() }
    }
}
