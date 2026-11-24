package ru.eleven.ompaway

import android.content.ClipboardManager
import android.content.Context
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/** Pairing lives in the home card; camera and verification never launch an activity. */
internal class PairingView(
    context: Context,
    private val app: Gateway,
    private val requestCamera: () -> Unit,
) : LinearLayout(context) {
    private enum class Mode { CHOOSE, SCAN, WAIT, VERIFY, RELAY, PAIRED }
    private val status = RadianceUi.text(context, "")
    private val notice = RadianceUi.text(context, "", 14)
    private val body = RadianceUi.column(context)
    private var mode: Mode? = null
    private var code: String? = null
    private var scanning = false
    private var active = false
    private var scanner: BarcodeView? = null

    init {
        orientation = VERTICAL
        background = RadianceUi.surface(context, RadianceUi.cardColor, 12)
        val padding = RadianceUi.dp(context, 16)
        setPadding(padding, padding, padding, padding)
        addView(RadianceUi.text(context, "Pair desktop", 20, heading = true))
        addView(status)
        addView(notice)
        addView(body, LayoutParams(-1, -2))
        message(null)
    }

    fun message(value: String?) {
        notice.text = value.orEmpty()
        notice.visibility = if (value.isNullOrEmpty()) GONE else VISIBLE
    }

    fun setActive(value: Boolean) {
        if (active == value) return
        active = value
        if (value && isAttachedToWindow) scanner?.resume() else scanner?.pause()
        if (!value && scanning) {
            scanning = false
            bind()
        }
    }

    fun startScan() {
        if (app.paired || app.pairing || !active) return
        message(null)
        scanning = true
        bind()
    }

    fun cancelScan(): Boolean {
        if (!scanning) return false
        scanning = false
        bind()
        return true
    }

    fun bind() {
        status.text = app.status
        val nextCode = app.verifyEmoji
        val next = when {
            app.needsRelayOrigin -> Mode.RELAY
            app.paired -> Mode.PAIRED
            nextCode != null -> Mode.VERIFY
            app.pairing -> Mode.WAIT
            scanning -> Mode.SCAN
            else -> Mode.CHOOSE
        }
        if (next == mode && nextCode == code) return
        scanner?.pause()
        scanner = null
        body.removeAllViews()
        mode = next; code = nextCode
        if (next != Mode.SCAN) scanning = false
        when (next) {
            Mode.CHOOSE -> {
                label("Run /away pair on your desktop, then scan its QR here. Compare every emoji on both screens.")
                button("Scan pairing QR", primary = true, action = requestCamera)
                button("Pair from clipboard") {
                    val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip
                    val raw = if (clip != null && clip.itemCount == 1) clip.getItemAt(0).text?.toString() else null
                    if (raw == null) message("Copy the desktop pairing JSON first.")
                    else { message(null); app.pair(raw) }
                }
            }
            Mode.SCAN -> {
                label("Point the camera at the QR on your desktop.")
                val preview = BarcodeView(context).apply {
                    setUseTextureView(true)
                    decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
                }
                scanner = preview
                body.addView(preview, LayoutParams(-1, RadianceUi.dp(context, 260)))
                preview.addStateListener(object : CameraPreview.StateListener {
                    override fun previewSized() = Unit
                    override fun previewStarted() = Unit
                    override fun previewStopped() = Unit
                    override fun cameraClosed() = Unit
                    override fun cameraError(error: Exception) {
                        if (scanner !== preview) return
                        cancelScan()
                        message("Camera unavailable. Try again or pair from the clipboard.")
                    }
                })
                preview.decodeSingle(object : BarcodeCallback {
                    override fun barcodeResult(result: BarcodeResult) {
                        if (!active || scanner !== preview) return
                        val raw = result.text
                        cancelScan()
                        if (raw.isNullOrBlank() || raw.length > 8192) message("Invalid pairing code. Try again.")
                        else { message(null); app.pair(raw) }
                    }
                })
                button("Cancel scan") { cancelScan() }
                if (active) preview.resume()
            }
            Mode.WAIT -> button("Cancel pairing") { app.retry() }
            Mode.VERIFY -> {
                val expected = checkNotNull(nextCode)
                label("Compare all 12 emoji, in order, with the code on the desktop.")
                body.addView(RadianceUi.text(context, expected, 30).apply {
                    contentDescription = "Verification code: $expected"
                })
                label("Only approve if they match exactly.")
                button("Codes match", primary = true) { app.confirm(expected, true) }
                button("Do not match") { app.confirm(expected, false) }
            }
            Mode.RELAY -> {
                label("Your pairing keys are retained. Enter the same trusted HTTPS relay as your desktop. Your saved credential is sent there; never enter an unfamiliar address.")
                val input = EditText(context).apply {
                    hint = "https://relay.example"
                    setTextColor(RadianceUi.cream); setHintTextColor(RadianceUi.muted)
                    backgroundTintList = android.content.res.ColorStateList.valueOf(RadianceUi.muted)
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
                    importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                    contentDescription = "Trusted HTTPS relay address"
                    minHeight = RadianceUi.dp(context, 56)
                }
                body.addView(input, LayoutParams(-1, -2))
                button("Restore relay", primary = true) { app.migrateRelayOrigin(input.text.toString()) }
            }
            Mode.PAIRED -> Unit
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (active) scanner?.resume()
    }

    override fun onDetachedFromWindow() {
        scanner?.pause()
        super.onDetachedFromWindow()
    }

    private fun label(value: String) {
        body.addView(RadianceUi.text(context, value))
    }

    private fun button(value: String, primary: Boolean = false, action: () -> Unit) {
        body.addView(RadianceUi.button(context, value, primary = primary) { if (active) action() }, RadianceUi.rowParams(context))
    }
}
