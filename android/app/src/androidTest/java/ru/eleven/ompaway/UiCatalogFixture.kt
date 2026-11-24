package ru.eleven.ompaway

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.view.inputmethod.InputMethodManager
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import ru.eleven.ompaway.security.PairedChannel
import ru.eleven.ompaway.security.Route
import ru.eleven.ompaway.security.Vault
import java.io.File
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Hosts production onCreate layouts, never the production foreground/transport lifecycle. */
internal class UiCatalogFixture(private val instrumentation: Instrumentation, private val arguments: Bundle) : AutoCloseable {
    private val target = instrumentation.targetContext.also {
        check(BuildConfig.ISOLATED_INTEGRATION && it.packageName == "ru.eleven.ompaway.integration") {
            "Catalog fixtures are forbidden outside the isolated integration package"
        }
    }
    private val prefix = "ui-catalog-${UUID.randomUUID()}"
    private val preferenceNames = linkedSetOf<String>()
    private val keyAlias = "$prefix-storage"
    private val configuration = Configuration(target.resources.configuration).apply {
        fontScale = arguments.getString("catalogFontScale")?.toFloat() ?: fontScale
        require(fontScale.isFinite() && fontScale in .85f..2.0f)
        arguments.getString("catalogWidthDp")?.toInt()?.let { require(it >= 240); screenWidthDp = it }
        arguments.getString("catalogHeightDp")?.toInt()?.let { require(it >= 200); screenHeightDp = it }
        orientation = if (screenWidthDp > screenHeightDp) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
    }
    private val context = object : ContextWrapper(target.createConfigurationContext(configuration)) {
        override fun getApplicationContext(): Context = this
        override fun getSharedPreferences(name: String, mode: Int) = super.getSharedPreferences("$prefix-$name".also {
            preferenceNames.add(it)
        }, mode)
    }
    private val captures = JSONArray()
    private val scenarios = JSONArray()
    private val selected = arguments.getString("catalogScenarios")?.split(',')?.map { it.trim() }?.toSet()
    private val run = arguments.getString("catalogRun") ?: "baseline"
    private val folder: File
    private val manifest: JSONObject
    private lateinit var host: Activity
    lateinit var app: Gateway
        private set
    lateinit var activity: Activity
        private set
    lateinit var root: View
        private set
    lateinit var screen: CallScreen
        private set
    private lateinit var channel: PairedChannel
    private lateinit var vault: Vault
    private var scenario = ""
    private var scenarioState = ""
    private var pageName = ""
    private var imageNumber = 0
    private var closed = false
    private var created = false
    private var inertCall: CallService? = null
    private var originalInteractiveWindows: Boolean? = null

    init {
        check(BuildConfig.ISOLATED_INTEGRATION && target.packageName == "ru.eleven.ompaway.integration") {
            "Screenshot catalog requires -PisolatedIntegration=true and the isolated target package"
        }
        require(Regex("[A-Za-z0-9_-]{1,48}").matches(run))
        folder = File(target.filesDir, "ui-catalog/$run")
        check(!folder.exists()) { "Use a new catalogRun; existing evidence is never overwritten" }
        check(folder.mkdirs())
        manifest = JSONObject().put("version", 1).put("run", run).put("status", "running")
            .put("provenance", "Synthetic fixture state in genuine production onCreate/render layouts, attached to a plain debug Activity window. UiAutomation compositor pixels, including GPU SurfaceViews. Not live network, pairing, submission or audio validation.")
            .put("fontScale", configuration.fontScale).put("requestedWidthDp", arguments.getString("catalogWidthDp"))
            .put("requestedHeightDp", arguments.getString("catalogHeightDp"))
            .put("scenarioFilter", selected?.let { JSONArray(it.toList()) } ?: JSONObject.NULL)
            .put("scenarios", scenarios).put("captures", captures).put("manualCoverage", JSONArray(listOf(
                "PairScanActivity: camera preview, scan success/cancel, camera permission grant/deny/permanent deny. Requires physical camera walkthrough; no camera is opened here.",
                "Android microphone/notification permissions and application settings, notification channel, DND, lock-screen and full-screen-intent settings. Device-owned state is not changed by this catalog.",
                "IncomingCallActivity lock-screen/unlock, notification heads-up/public/private previews, invitation expiry/decline and AnswerCall alias routing require a real system activity/notification walkthrough.",
                "FLAG_SECURE enforcement needs a separate negative capture check. Settings privacy-enabled fixture only renders the checked production control in a deliberately capture-enabled synthetic window.",
                "Live pairing, mismatch/recovery transport, real desktop receipts, microphone/audio routing, voice interruption and service lifecycle are not exercised; their visual states are synthetic.",
                "Actual device rotation, system font setting changes, navigation gestures and process recreation are separate walkthroughs. Optional fontScale/window dimensions affect only fixture resources and the host window."
            )))
        saveManifest()
    }

    fun start() {
        check(BuildConfig.ISOLATED_INTEGRATION)
        val automation = instrumentation.uiAutomation
        val service = checkNotNull(automation.serviceInfo)
        val windowFlag = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        originalInteractiveWindows = service.flags and windowFlag != 0
        manifest.put("accessibilityFlagsBefore", service.flags)
        service.flags = service.flags or windowFlag
        automation.serviceInfo = service
        manifest.put("accessibilityFlagsRequested", service.flags)
        saveManifest()
        host = instrumentation.startActivitySync(Intent(target, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        main {
            host.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            host.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            host.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= 30) host.window.setDecorFitsSystemWindows(false)
            else {
                @Suppress("DEPRECATION")
                host.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            }
            if (Build.VERSION.SDK_INT >= 30) host.window.insetsController?.setSystemBarsAppearance(0,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
            @Suppress("DEPRECATION")
            host.window.statusBarColor = android.graphics.Color.TRANSPARENT
            @Suppress("DEPRECATION")
            host.window.navigationBarColor = android.graphics.Color.TRANSPARENT
            host.window.isStatusBarContrastEnforced = false
            host.window.isNavigationBarContrastEnforced = false
            val density = target.resources.displayMetrics.density
            val width = arguments.getString("catalogWidthDp")?.toInt()?.let { (it * density).toInt() } ?: -1
            val height = arguments.getString("catalogHeightDp")?.toInt()?.let { (it * density).toInt() } ?: -1
            require(width <= target.resources.displayMetrics.widthPixels && height <= target.resources.displayMetrics.heightPixels) {
                "Fixture window must fit this display; use a shorter landscape window rather than changing device rotation"
            }
            host.window.setLayout(width, height)
            app = Instrumentation.newApplication(Gateway::class.java, context) as Gateway
            put(app, "store", InboxStore(context))
            val session = invoke(app, "current")!!
            channel = get(session, "channel") as PairedChannel
            channel.close()
            vault = get(channel, "vault") as Vault
            // Keep even encrypted synthetic data/key material out of the target's ordinary vault.
            put(vault, "alias", keyAlias)
            ScreenPreferences(context).apply { blockScreenshots = false; animations = true; lightBackdrop = true; quality = 0 }
            attach(InboxActivity::class.java)
        }
        settle()
    }

    fun wanted(name: String) = selected == null || selected.any { name == it || name.startsWith("$it-") }

    fun scenario(name: String, page: String, state: String, configure: () -> Unit = {}, interact: () -> Unit = {}) {
        if (!wanted(name)) return
        scenario = name; scenarioState = state; pageName = page; imageNumber = 0
        main {
            reset()
            configure()
            show(page)
        }
        settle()
        main(interact)
        settle()
        if (name == "form-text-selection") {
            settle(500)
            longPressSelectionText()
            settle(400)
            // Scrolling dismisses Android's floating toolbar; other form scenarios cover scrolling.
            capture()
        } else captureScrolls()
        scenarios.put(JSONObject().put("name", name).put("page", page).put("state", state).put("images", imageNumber))
        saveManifest()
    }

    fun paired(legacy: Boolean = false) {
        context.getSharedPreferences("away.sealed.v1", Context.MODE_PRIVATE).edit().clear().commit()
        vault.save(Route("00000000-0000-4000-8000-000000000001", "synthetic-not-a-credential",
            "synthetic-desktop-pin", "synthetic-phone-pin", if (legacy) null else "https://catalog.invalid"))
    }

    fun reset() {
        check(activity is InboxActivity)
        inertCall?.invalidate(); inertCall = null
        put(app, "call", null); put(activity, "callSource", null)
        hideKeyboard()
        (get(activity, "formViews") as MutableMap<*, *>).clear()
        (get(activity, "detailViews") as MutableMap<*, *>).clear()
        app.store.state.apply {
            pending.clear(); invited.clear(); silenced.clear(); closed.clear(); acknowledged.clear()
            alerted.clear(); details.clear(); proposals.clear()
        }
        app.forms.clear(); app.drafts.clear(); app.noteDrafts.clear(); app.formMessages.clear(); app.submitting.clear()
        (get(app, "loadingForms") as MutableSet<*>).clear()
        put(app, "verifiedInbox", false); put(app, "status", "Offline"); put(app, "pairing", false)
        put(app, "verifyEmoji", null); put(app, "answerReceipt", null); put(app, "endingId", null)
        put(activity, "notice", null); put(activity, "shownEmoji", null); put(activity, "selectedId", null)
        put(activity, "renderedPage", null); put(activity, "renderedId", null)
        context.getSharedPreferences("away.sealed.v1", Context.MODE_PRIVATE).edit().clear().commit()
        ScreenPreferences(context).apply { blockScreenshots = false; animations = true; lightBackdrop = true; quality = 0 }
        app.inviteSettings.apply { callMode = false; showPreview = false }
        screen.bind(null); screen.refreshAppearance(); screen.setSpeaker(false)
    }

    fun show(page: String) {
        val field = activity.javaClass.getDeclaredField("page").apply { isAccessible = true }
        field.set(activity, field.type.enumConstants!!.single { (it as Enum<*>).name == page })
        put(activity, "renderedPage", null)
        put(activity, "resumed", true)
        try { invoke(activity, "render") } finally { put(activity, "resumed", false) }
    }

    fun connected() { paired(); put(app, "verifiedInbox", true); put(app, "status", "Connected to desktop") }

    fun activeCall(id: String) {
        check(inertCall == null)
        val call = CallService(context, id, { error("Catalog must not send audio") },
            { error("Catalog must not acknowledge audio") }, { error("Catalog must not start audio") })
        // Construction only builds attributes/focus descriptions. start() is NEVER invoked.
        inertCall = call
        put(call, "connected", true)
        put(app, "call", call); put(app, "talking", true)
        put(app, "callerCaption", "Please review this synthetic proposal.")
        put(app, "callerCaptionFinal", true)
        put(app, "assistantCaption", "The proposal is not a submitted answer.")
        put(app, "assistantCaptionFinal", true)
        put(activity, "callSource", call)
        screen.bind(call)
    }
    fun selectionMenu() {
        val editor = views().filterIsInstance<android.widget.EditText>().first { it.isShown }
        editor.setText("Select this synthetic sentence for the context menu.")
        editor.requestFocus()
        editor.requestRectangleOnScreen(Rect(0, 0, editor.width, editor.height), true)
        editor.setSelection(0)
        host.getSystemService(InputMethodManager::class.java).showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun longPressSelectionText() {
        var x = 0f
        var y = 0f
        main {
            val editor = views().filterIsInstance<android.widget.EditText>().first { it.isShown }
            val layout = checkNotNull(editor.layout)
            val offset = 3 // Inside the first synthetic word, rather than empty editor padding.
            val line = layout.getLineForOffset(offset)
            val localX = editor.totalPaddingLeft + layout.getPrimaryHorizontal(offset) - editor.scrollX
            val localY = editor.totalPaddingTop + (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f - editor.scrollY
            val visible = Rect()
            check(editor.getLocalVisibleRect(visible) && visible.contains(localX.toInt(), localY.toInt())) {
                "Selection gesture must land on visible native editor text"
            }
            val location = IntArray(2)
            editor.getLocationOnScreen(location)
            x = location[0] + localX
            y = location[1] + localY
        }
        val downTime = SystemClock.uptimeMillis()
        fun inject(action: Int) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0).apply {
                source = InputDevice.SOURCE_TOUCHSCREEN
            }
            try {
                check(instrumentation.uiAutomation.injectInputEvent(event, true)) { "Native selection touch injection failed" }
            } finally { event.recycle() }
        }
        // Run off the main thread so Android can dispatch the gesture and long-press timeout.
        try {
            inject(MotionEvent.ACTION_DOWN)
            SystemClock.sleep(ViewConfiguration.getLongPressTimeout().toLong() + 250L)
        } finally { inject(MotionEvent.ACTION_UP) }
    }


    fun preferences() = ScreenPreferences(context)
    fun views(): List<View> = descendants(root)
    fun select(id: String) { put(activity, "selectedId", id) }
    fun loading(id: String) { @Suppress("UNCHECKED_CAST") val ids = get(app, "loadingForms") as MutableSet<String>; ids.add(id) }

    fun voice(name: String, renderer: Int, active: Boolean, connected: Boolean, mic: Float, playback: Float,
              caller: String = "", callerFinal: Boolean = false, assistant: String = "", assistantFinal: Boolean = false,
              panel: Boolean = false, dismissing: Boolean = false, motion: Boolean = true, light: Boolean = true,
              panelForm: JSONObject? = null, speakerOn: Boolean = false) {
        if (!wanted(name)) return
        scenario = name; scenarioState = "Visual-only source; active=$active connected=$connected micLevel=$mic playbackLevel=$playback; no media"; pageName = if (panel) "REQUESTS + voice overlay" else "CallScreen"; imageNumber = 0
        main {
            reset(); this.connected()
            if (panel) {
                val id = "00000000-0000-4000-8000-000000000001"
                app.store.state.pending[id] = Pending(id, "Catalog project", "Review the synthetic question.", 1_700_000_000_000L)
                app.forms[id] = checkNotNull(panelForm)
                activeCall(id)
            }
            preferences().apply { quality = renderer; animations = motion; lightBackdrop = light }
            show("REQUESTS")
            screen.bind(if (name.endsWith("-idle")) null else object : CallVisualSource {
                override val active = active
                override val connected = connected
                override fun microphoneLevel(nowMillis: Long) = mic
                override fun playbackLevel() = playback
            })
            (get(activity, "panel") as View).visibility = if (panel) View.VISIBLE else View.GONE
            screen.setPanelOpen(panel); screen.refreshAppearance()
            screen.setSpeaker(speakerOn)
            screen.captions(caller, callerFinal, assistant, assistantFinal)
            if (dismissing) screen.dismiss { }
        }
        settle(if (dismissing) 250 else 1100)
        // Refresh transcript status after the visual state machine has reached its requested mode.
        if (active && connected && !dismissing) main { screen.captions(caller, callerFinal, assistant, assistantFinal) }
        captureScrolls()
        scenarios.put(JSONObject().put("name", name).put("page", pageName).put("state", scenarioState).put("images", imageNumber))
        saveManifest()
    }

    fun incoming() {
        if (!wanted("incoming-call")) return
        scenario = "incoming-call"; scenarioState = "Synthetic pending invitation; no notification, expiry, answer or audio action"; pageName = "IncomingCallActivity"; imageNumber = 0
        main { reset(); attach(IncomingCallActivity::class.java) }
        settle(1100)
        captureScrolls()
        scenarios.put(JSONObject().put("name", scenario).put("page", pageName).put("state", scenarioState).put("images", imageNumber))
        saveManifest()
    }

    private fun attach(type: Class<out Activity>) {
        if (created) { screen.dispose(); instrumentation.callActivityOnDestroy(activity); created = false }
        val intent = Intent(context, type)
        if (type == IncomingCallActivity::class.java) {
            val id = "00000000-0000-4000-8000-000000000009"
            intent.putExtra(Invites.ID, id).putExtra("expiresAt", SystemClock.elapsedRealtime() + 45_000L)
        }
        @Suppress("DEPRECATION")
        val next = instrumentation.newActivity(type, context, null, app, intent,
            ActivityInfo().apply { applicationInfo = target.applicationInfo; name = type.name }, "Synthetic UI catalog", null, null, null)
        activity = next
        next.setTheme(android.R.style.Theme_Material_Light_NoActionBar)
        instrumentation.callActivityOnCreate(next, Bundle())
        created = true
        if (next is IncomingCallActivity) {
            (get(next, "main") as Handler).removeCallbacks(get(next, "expire") as Runnable)
            screen = get(next, "scene") as CallScreen
        } else screen = get(next, "callScreen") as CallScreen
        val content = next.findViewById<ViewGroup>(android.R.id.content)
        root = content.getChildAt(0)
        content.removeView(root)
        host.setContentView(root)
        root.requestApplyInsets()
        screen.resume()
    }

    fun keyboard() {
        val editor = views().filterIsInstance<android.widget.EditText>().first { it.visibility == View.VISIBLE }
        editor.requestFocus()
        editor.requestRectangleOnScreen(Rect(0, 0, editor.width, editor.height), true)
        host.getSystemService(InputMethodManager::class.java).showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideKeyboard() {
        if (::root.isInitialized) {
            host.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(root.windowToken, 0)
            root.clearFocus()
        }
    }

    private fun captureScrolls() {
        val scrolls = mutableListOf<View>()
        main { scrolls.addAll(views().filter { it is ScrollView || it is HorizontalScrollView }.filter { it.isShown }) }
        capture()
        for (scroll in scrolls) {
            var canScroll = false
            main {
                scroll.requestRectangleOnScreen(Rect(0, 0, scroll.width, minOf(scroll.height, root.height)), true)
                scroll.scrollTo(0, 0)
                canScroll = scroll.canScrollVertically(1) || scroll.canScrollHorizontally(1)
            }
            if (!canScroll) continue
            settle()
            capture()
            var segments = 0
            while (canScroll) {
                check(++segments <= 100) { "Scroll coverage exceeded 100 segments; refusing an incomplete catalog" }
                main {
                    val x = scroll.scrollX; val y = scroll.scrollY
                    if (scroll is HorizontalScrollView) scroll.scrollBy(maxOf(1, scroll.width * 4 / 5), 0)
                    else scroll.scrollBy(0, maxOf(1, scroll.height * 4 / 5))
                    check(scroll.scrollX != x || scroll.scrollY != y) { "Scrollable viewport did not advance" }
                }
                settle()
                capture()
                main { canScroll = scroll.canScrollVertically(1) || scroll.canScrollHorizontally(1) }
            }
        }
    }

    private fun capture() {
        instrumentation.waitForIdleSync()
        val bounds = Rect()
        val offsets = JSONArray()
        var renderer = ""
        var imeVisible = false
        main {
            check(!host.isFinishing && host.hasWindowFocus() && root.isAttachedToWindow && root.getGlobalVisibleRect(bounds)) {
                "Catalog window must be visible and foreground; unlock the device before running"
            }
            val location = IntArray(2)
            root.getLocationOnScreen(location)
            bounds.set(location[0], location[1], location[0] + root.width, location[1] + root.height)
            check((get(channel, "closed") as AtomicBoolean).get())
            check(get(app, "observer") == null && app.callVisual === inertCall)
            inertCall?.let {
                check(get(it, "started") == false && get(it, "recording") == null &&
                    get(it, "output") == null && get(it, "ownsFocus") == false)
            }
            renderer = if (get(screen, "surface") == null || get(screen, "backgroundSurface") == null ||
                preferences().quality == 2 || (preferences().quality == 0 && get(screen, "autoFlat") == true)) "2d" else "gpu"
            if (Build.VERSION.SDK_INT >= 30) imeVisible = root.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true
            views().filter { it is ScrollView || it is HorizontalScrollView }.forEach {
                offsets.put(JSONObject().put("type", it.javaClass.simpleName).put("x", it.scrollX).put("y", it.scrollY)
                    .put("width", it.width).put("height", it.height).put("visible", it.isShown))
            }
        }
        if (scenario == "form-keyboard") check(imeVisible) { "IME did not open; keyboard scenario must not be reported as captured" }
        if (scenario == "form-text-selection") {
            val windows = instrumentation.uiAutomation.windows
            val activeRoot = instrumentation.uiAutomation.rootInActiveWindow
            val roots = listOfNotNull(activeRoot) + windows.mapNotNull { it.root }
            val copy = target.getString(android.R.string.copy)
            if (!roots.any { node -> node.findAccessibilityNodeInfosByText(copy).any { it.isVisibleToUser } }) {
                val failure = IllegalStateException("Native selection menu is not visible; do not count this scenario as captured")
                try { saveSelectionDiagnostics(activeRoot, windows) }
                catch (diagnosticFailure: Throwable) { failure.addSuppressed(diagnosticFailure) }
                throw failure
            }
        }
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "Compositor screenshot unavailable" }
        val cropped: Bitmap
        try {
            if (imeVisible) bounds.set(0, 0, image.width, image.height)
            check(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= image.width && bounds.bottom <= image.height)
            cropped = Bitmap.createBitmap(image, bounds.left, bounds.top, bounds.width(), bounds.height())
            val name = "${scenario}_${(imageNumber++).toString().padStart(3, '0')}.png"
            try { File(folder, name).outputStream().use { check(cropped.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { if (cropped !== image) cropped.recycle() }
            captures.put(JSONObject().put("file", name).put("scenario", scenario).put("state", scenarioState).put("page", pageName)
                .put("activityLayout", activity.javaClass.simpleName).put("synthetic", true).put("renderer", renderer)
                .put("requestedRenderer", preferences().quality).put("animations", preferences().animations)
                .put("referenceBackdrop", preferences().lightBackdrop).put("fontScale", configuration.fontScale)
                .put("density", root.resources.displayMetrics.density).put("imeVisible", imeVisible)
                .put("crop", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom))).put("scrolls", offsets))
        } finally { image.recycle() }
        saveManifest()
    }

    /** App-private failure evidence only: may include OS UI; never add it to successful captures. */
    private fun saveSelectionDiagnostics(activeRoot: AccessibilityNodeInfo?, windows: List<AccessibilityWindowInfo>) {
        val imageName = "PRIVATE-selection-failure.png"
        val treeName = "PRIVATE-selection-failure.json"
        val diagnostic = JSONObject().put("private", true).put("successfulCapture", false).put("scenario", scenario)
            .put("warning", "Private diagnostic may contain OS UI text. Inspect locally; do not commit or publish.")
            .put("accessibilityFlags", instrumentation.uiAutomation.serviceInfo?.flags)
        val screenshotFailure = runCatching {
            val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "Diagnostic compositor screenshot unavailable" }
            try { File(folder, imageName).outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { image.recycle() }
            diagnostic.put("image", imageName)
        }.exceptionOrNull()
        screenshotFailure?.let { diagnostic.put("screenshotFailureType", it.javaClass.simpleName) }
        val budget = intArrayOf(10_000)
        diagnostic.put("activeRoot", diagnosticNode(activeRoot, budget, 0))
        diagnostic.put("windows", JSONArray().apply {
            for (window in windows) {
                val bounds = Rect()
                window.getBoundsInScreen(bounds)
                put(JSONObject().put("id", window.id).put("type", window.type).put("layer", window.layer)
                    .put("title", window.title?.toString()).put("active", window.isActive).put("focused", window.isFocused)
                    .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
                    .put("root", diagnosticNode(window.root, budget, 0)))
            }
        })
        File(folder, treeName).writeText(diagnostic.toString(2))
        manifest.put("privateFailureDiagnostics", JSONObject().put("tree", treeName)
            .put("image", if (screenshotFailure == null) imageName else JSONObject.NULL).put("successfulCapture", false))
        saveManifest()
    }

    private fun diagnosticNode(node: AccessibilityNodeInfo?, budget: IntArray, depth: Int): Any {
        if (node == null) return JSONObject.NULL
        if (budget[0]-- <= 0 || depth > 64) return JSONObject().put("truncated", true)
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return JSONObject().put("class", node.className?.toString()).put("package", node.packageName?.toString())
            .put("viewId", node.viewIdResourceName).put("text", node.text?.toString())
            .put("contentDescription", node.contentDescription?.toString()).put("visible", node.isVisibleToUser)
            .put("focused", node.isFocused).put("selected", node.isSelected).put("enabled", node.isEnabled)
            .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
            .put("actions", JSONArray().apply {
                node.actionList.forEach { put(JSONObject().put("id", it.id).put("label", it.label?.toString())) }
            }).put("children", JSONArray().apply {
                for (index in 0 until node.childCount) put(diagnosticNode(node.getChild(index), budget, depth + 1))
            })
    }

    private fun restoreAccessibilityWindowFlag() {
        val wasEnabled = originalInteractiveWindows ?: return
        val automation = instrumentation.uiAutomation
        val service = checkNotNull(automation.serviceInfo)
        val flag = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        service.flags = if (wasEnabled) service.flags or flag else service.flags and flag.inv()
        automation.serviceInfo = service
        originalInteractiveWindows = null
    }

    fun finish() {
        check(scenarios.length() > 0) { "No catalog scenario matched" }
        manifest.put("status", "captured-awaiting-human-review")
        saveManifest()
        instrumentation.sendStatus(0, Bundle().apply {
            putString("stream", "Synthetic UI catalog: files/ui-catalog/$run/manifest.json (${captures.length()} PNGs). Human inspection still required.\n")
        })
    }

    fun failed(error: Throwable) { manifest.put("status", "failed").put("failureType", error.javaClass.simpleName); saveManifest() }
    private fun saveManifest() { File(folder, "manifest.json").writeText(manifest.toString(2)) }
    fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)
    private fun settle(milliseconds: Long = 200) { instrumentation.waitForIdleSync(); SystemClock.sleep(milliseconds); instrumentation.waitForIdleSync() }

    override fun close() {
        if (closed) return
        closed = true
        try {
            main {
                if (::root.isInitialized) hideKeyboard()
                inertCall?.invalidate(); inertCall = null
                if (::screen.isInitialized) screen.dispose()
                if (created) { instrumentation.callActivityOnDestroy(activity); created = false }
                if (::channel.isInitialized) channel.close()
                if (::host.isInitialized) host.finish()
            }
        } finally {
            try {
                preferenceNames.forEach {
                    target.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit()
                    target.deleteSharedPreferences(it)
                }
                KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (containsAlias(keyAlias)) deleteEntry(keyAlias) }
            } finally { restoreAccessibilityWindowFlag() }
        }
    }

    companion object {
        fun descendants(view: View): List<View> = listOf(view) + if (view is ViewGroup)
            (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
        fun get(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)
        fun put(target: Any, name: String, value: Any?) = target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
        private fun invoke(target: Any, name: String): Any? = target.javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(target)
    }
}
