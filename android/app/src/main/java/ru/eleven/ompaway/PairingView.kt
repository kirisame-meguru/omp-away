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
        addView(RadianceUi.text(context, context.uiString(R.string.pair_desktop), 20, heading = true))
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
                label(context.uiString(R.string.run_away_pair_on_your_desktop_then_scan_its_qr))
                button(context.uiString(R.string.scan_pairing_qr), primary = true, action = requestCamera)
                button(context.uiString(R.string.pair_from_clipboard)) {
                    val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip
                    val raw = if (clip != null && clip.itemCount == 1) clip.getItemAt(0).text?.toString() else null
                    if (raw == null) message(context.uiString(R.string.copy_the_desktop_pairing_json_first))
                    else { message(null); app.pair(raw) }
                }
            }
            Mode.SCAN -> {
                label(context.uiString(R.string.point_the_camera_at_the_qr_on_your_desktop))
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
                        message(context.uiString(R.string.camera_unavailable_try_again_or_pair_from_the_clipboard))
                    }
                })
                preview.decodeSingle(object : BarcodeCallback {
                    override fun barcodeResult(result: BarcodeResult) {
                        if (!active || scanner !== preview) return
                        val raw = result.text
                        cancelScan()
                        if (raw.isNullOrBlank() || raw.length > 8192) message(context.uiString(R.string.invalid_pairing_code_try_again))
                        else { message(null); app.pair(raw) }
                    }
                })
                button(context.uiString(R.string.cancel_scan)) { cancelScan() }
                if (active) preview.resume()
            }
            Mode.WAIT -> button(context.uiString(R.string.cancel_pairing)) { app.retry() }
            Mode.VERIFY -> {
                val expected = checkNotNull(nextCode)
                label(context.uiString(R.string.compare_all_12_emoji_in_order_with_the_code_on))
                body.addView(RadianceUi.text(context, expected, 30).apply {
                    contentDescription = context.uiString(R.string.verification_code, expected)
                })
                label(context.uiString(R.string.only_approve_if_they_match_exactly))
                button(context.uiString(R.string.codes_match), primary = true) { app.confirm(expected, true) }
                button(context.uiString(R.string.do_not_match)) { app.confirm(expected, false) }
            }
            Mode.RELAY -> {
                label(context.uiString(R.string.your_pairing_keys_are_retained_enter_the_same_trusted_https))
                val input = EditText(context).apply {
                    hint = "https://relay.example"
                    isSaveEnabled = false
                    setText(app.relayDraft)
                    addTextChangedListener(object : android.text.TextWatcher {
                        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { app.relayDraft = s?.toString().orEmpty() }
                        override fun afterTextChanged(s: android.text.Editable?) = Unit
                    })
                    setTextColor(RadianceUi.cream); setHintTextColor(RadianceUi.muted)
                    backgroundTintList = android.content.res.ColorStateList.valueOf(RadianceUi.muted)
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
                    importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                    contentDescription = context.uiString(R.string.trusted_https_relay_address)
                    minHeight = RadianceUi.dp(context, 56)
                }
                body.addView(input, LayoutParams(-1, -2))
                button(context.uiString(R.string.restore_relay), primary = true) { app.migrateRelayOrigin(input.text.toString()) }
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
