package ru.eleven.ompaway.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager
import javax.security.auth.x500.X500Principal
import org.json.JSONObject

private const val PROVIDER = "AndroidKeyStore"
internal fun base64url(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
internal fun digestBytes(encoded: String): ByteArray {
    require(encoded.length == 43)
    val bytes = Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    require(bytes.size == 32 && base64url(bytes) == encoded)
    return bytes
}
internal fun pinOf(cert: X509Certificate): String = base64url(MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded))

internal class PhoneIdentity private constructor(val alias: String, val key: PrivateKey, val certificate: X509Certificate) {
    val pin = pinOf(certificate)

    fun manager() = object : X509ExtendedKeyManager() {
        override fun getCertificateChain(candidate: String?) = if (candidate == alias) arrayOf(certificate) else null
        override fun getPrivateKey(candidate: String?) = if (candidate == alias) key else null
        override fun getClientAliases(type: String?, issuers: Array<out Principal>?) = if (type == "EC") arrayOf(alias) else null
        override fun chooseClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = alias.takeIf { types?.contains("EC") == true }
        override fun chooseEngineClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = chooseClientAlias(types, issuers, null)
        override fun getServerAliases(type: String?, issuers: Array<out Principal>?): Array<String>? = null
        override fun chooseServerAlias(type: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
    }

    companion object {
        @Synchronized fun open(alias: String, create: Boolean): PhoneIdentity {
            val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
            if (!store.containsAlias(alias)) {
                check(create) { "Paired phone identity unavailable" }
                val now = System.currentTimeMillis()
                val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                    .setCertificateSubject(X500Principal("CN=Away handset"))
                    .setCertificateSerialNumber(BigInteger.ONE)
                    .setCertificateNotBefore(Date(now - 86_400_000L))
                    .setCertificateNotAfter(Date(now + 20L * 366 * 86_400_000L)).build()
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec); generateKeyPair() }
            }
            return PhoneIdentity(alias, store.getKey(alias, null) as PrivateKey, store.getCertificate(alias) as X509Certificate)
        }
    }
}

// The pin is conveyed out of band. Public Internet HTTPS/WSS uses OkHttp's untouched system trust.
internal class PinnedServer(expected: String) : X509TrustManager {
    private val digest = digestBytes(expected)
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Missing desktop identity")
        leaf.checkValidity()
        if (!MessageDigest.isEqual(digest, MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded))) throw CertificateException("Desktop pin mismatch")
    }
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) { throw CertificateException("Client trust not supported") }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

private val symbols = listOf("🐶", "🐱", "🦊", "🐻", "🐼", "🐸", "🐵", "🐯", "🦁", "🐷", "🐨", "🐰", "🐙", "🐧", "🐳", "🐢")
internal fun fingerprint(desktop: ByteArray, phone: ByteArray, nonce: ByteArray): String {
    require(desktop.size == 32 && phone.size == 32 && nonce.size == 32)
    val hash = MessageDigest.getInstance("SHA-256").apply {
        update("omp-away/1\u0000".toByteArray(Charsets.US_ASCII)); update(desktop); update(phone); update(nonce)
    }.digest()
    return buildString { for (i in 0 until 6) { val b = hash[i].toInt() and 255; append(symbols[b ushr 4]); append(symbols[b and 15]) } }
}

internal class EnrollmentGate(val emoji: String) {
    private enum class Stage { VERIFY, DISPLAYED, ACCEPTED, CLOSED }
    private var stage = Stage.VERIFY
    fun verify(remote: String) { check(stage == Stage.VERIFY && emoji == remote); stage = Stage.DISPLAYED }
    fun accept(displayed: String) { check(stage == Stage.DISPLAYED && emoji == displayed); stage = Stage.ACCEPTED }
    fun paired() { check(stage == Stage.ACCEPTED); stage = Stage.CLOSED }
    fun cancel() { stage = Stage.CLOSED }
}

internal class Route(val deviceId: String, val token: String, val desktopPin: String, val phonePin: String)

internal class Vault(context: Context) {
    private val prefs = context.getSharedPreferences("away.sealed.v1", Context.MODE_PRIVATE)
    private val alias = "away.storage.v1"
    fun paired() = prefs.contains("route")

    private fun storageKey(create: Boolean): SecretKey = synchronized(Vault::class.java) {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey) ?: run {
            check(create && !paired() && !prefs.contains("fcm")) { "Sealed storage unavailable" }
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }
    }
    private fun put(name: String, text: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, storageKey(true)); updateAAD(name.toByteArray()) }
        val iv = cipher.iv
        check(iv.size == 12)
        val value = Base64.encodeToString(iv + cipher.doFinal(text.toByteArray()), Base64.NO_WRAP)
        check(prefs.edit().putString(name, value).commit())
    }
    private fun get(name: String): String? {
        val value = prefs.getString(name, null) ?: return null
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.size >= 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, storageKey(false), GCMParameterSpec(128, bytes, 0, 12)); updateAAD(name.toByteArray())
        }
        return String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    }
    fun save(route: Route) = synchronized(Vault::class.java) {
        check(!paired()) { "Cannot replace paired keys" }
        put("route", JSONObject().put("deviceId", route.deviceId).put("token", route.token)
            .put("desktopPin", route.desktopPin).put("phonePin", route.phonePin).toString())
    }
    fun route() = get("route")?.let { value -> JSONObject(value).run { Route(getString("deviceId"), getString("token"), getString("desktopPin"), getString("phonePin")) } }
    fun fcm(): String? = get("fcm")
    fun setFcm(value: String) = put("fcm", value)
}
