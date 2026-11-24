package ru.eleven.ompaway

import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

class RadianceHomeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test fun questionsAreTheLaunchScreenAndPanelsDoNotReplaceTheirRenderer() {
        val activity = launch()
        try {
            instrumentation.runOnMainSync {
                val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().singleOrNull()
                assertNotNull("Radiance must be visible before a voice call", scene)
                assertTrue(texts(activity.window.decorView).contains("away"))
                assertFalse(texts(activity.window.decorView).any {
                    it.contains("RADIANCE", true) || it.contains("R A D I A N C E") ||
                        it.contains("fps", true) || it.contains("native lens", true) ||
                        it.contains("animation", true) || it.contains("Animate voice")
                })
                assertEquals("Idle must not invent microphone energy", 0f, scene!!.energy(0f, 1), 0f)
                val shell = CallScreen::class.java.getDeclaredField("shell").apply { isAccessible = true }
                    .get(scene) as com.example.radiance.ShellMotion
                assertEquals("No lens before an explicit voice action", 0f, shell.opacity, 0f)
                assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, scene.layoutParams.height)
                assertEquals(scene.height, scene.getChildAt(0).height)
                val panel = InboxActivity::class.java.getDeclaredField("panel").apply { isAccessible = true }.get(activity) as View
                val margin = (panel.layoutParams as android.widget.FrameLayout.LayoutParams).topMargin
                assertEquals(RadianceUi.dp(activity, 12), margin)
                val settings = descendants(activity.window.decorView).filterIsInstance<android.widget.ImageButton>()
                    .single { it.contentDescription == "Settings" }
                assertTrue(settings.isShown)
                assertTrue(settings.width >= RadianceUi.dp(activity, 48))
                assertTrue(settings.height >= RadianceUi.dp(activity, 48))
                assertFalse(descendants(activity.window.decorView).filterIsInstance<android.widget.Button>()
                    .any { it.isShown && it.text.toString() in listOf("Settings", "Refresh questions", "Reconnect") })
                val refresh = descendants(activity.window.decorView)
                    .filterIsInstance<androidx.swiperefreshlayout.widget.SwipeRefreshLayout>().single()
                assertFalse("Unpaired inbox must not refresh", refresh.isEnabled)
            }
            val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
            val renderer = scene.getChildAt(0)
            await { texts(activity.window.decorView).contains("Questions") }
            click("Settings")
            click("Done")
            instrumentation.runOnMainSync {
                assertSame(scene, descendants(activity.window.decorView).filterIsInstance<CallScreen>().single())
                assertSame(renderer, scene.getChildAt(0))
                assertNull((context.applicationContext as Gateway).callVisual)
            }
            click("Settings")
            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            await {
                activity.hasWindowFocus() && instrumentation.uiAutomation.rootInActiveWindow
                    ?.findAccessibilityNodeInfosByText("Questions")?.any { it.isVisibleToUser } == true
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun appearanceControlsKeepTheRendererAndRestoreTheirPreferences() {
        val preferences = ScreenPreferences(context)
        val previousQuality = preferences.quality
        val previousAnimations = preferences.animations
        val previousLight = preferences.lightBackdrop
        val activity = launch()
        try {
            val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
            val native = scene.getChildAt(0)
            click("Settings")
            click("2D")
            await { preferences.quality == 2 }
            instrumentation.runOnMainSync {
                assertTrue(descendants(scene.voiceOverlay).filterIsInstance<com.example.radiance.OrbFallback>().single().visibility == View.VISIBLE)
                assertSame(native, scene.getChildAt(0))
            }
            click("GPU")
            await { preferences.quality == 1 }
            instrumentation.runOnMainSync {
                assertTrue(native is com.example.radiance.OrbSurface && native.visibility == View.VISIBLE)
                assertSame(native, scene.getChildAt(0))
            }
            click("Animations")
            await { preferences.animations != previousAnimations }
            click("Reference backdrop")
            await { preferences.lightBackdrop != previousLight }
            click("Done")
            assertNull((context.applicationContext as Gateway).callVisual)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            preferences.quality = previousQuality
            preferences.animations = previousAnimations
            preferences.lightBackdrop = previousLight
        }
    }

    @Test fun screenshotSwitchAppliesImmediatelyToWindowsAndSurvivesRelaunch() {
        val preferences = context.getSharedPreferences("screen", 0)
        val previous = preferences.getBoolean("blockScreenshots", true)
        // Some development ROMs explicitly override every application's secure-window flag.
        val secureWindowsAllowed = android.provider.Settings.Secure.getInt(context.contentResolver, "window_ignore_secure", 0) == 0
        preferences.edit().remove("blockScreenshots").commit()
        var activity = launch()
        try {
            assertEquals(secureWindowsAllowed, secure(activity))
            click("Settings")
            click("Block screenshots")
            await { !preferences.getBoolean("blockScreenshots", true) && !secure(activity) }
            instrumentation.runOnMainSync {
                assertEquals(1, descendants(activity.window.decorView).filterIsInstance<CallScreen>().size)
                assertTrue(texts(activity.window.decorView).contains("Settings"))
            }
            click("Done")
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            activity = launch()
            assertFalse("Screenshot choice was not persisted", secure(activity))
            assertFalse("Stored screenshot choice was not persisted", preferences.getBoolean("blockScreenshots", true))
            click("Settings")
            click("Block screenshots")
            await { preferences.getBoolean("blockScreenshots", false) && secure(activity) == secureWindowsAllowed }
            click("Done")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            preferences.edit().putBoolean("blockScreenshots", previous).commit()
        }
    }

    @Test fun animationsDefaultOnAndPersistOnlyThroughSettings() {
        val stored = context.getSharedPreferences("screen", 0)
        val saved = stored.all
        stored.edit().remove("animations").remove("reducedMotion").remove("animateOverride").commit()
        var activity = launch()
        try {
            assertTrue(ScreenPreferences(context).animations)
            click("Settings")
            click("Animations")
            await { !ScreenPreferences(context).animations }
            click("Done")
            instrumentation.runOnMainSync {
                assertFalse(descendants(activity.window.decorView).filterIsInstance<android.widget.Switch>()
                    .any { it.text.toString() == "Animations" && it.isShown })
                activity.finish()
            }
            instrumentation.waitForIdleSync()
            activity = launch()
            assertFalse(ScreenPreferences(context).animations)
            click("Settings")
            click("Animations")
            await { ScreenPreferences(context).animations }
            click("Done")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            val editor = stored.edit()
            for (key in listOf("animations", "reducedMotion", "animateOverride")) {
                val value = saved[key]
                if (value is Boolean) editor.putBoolean(key, value) else editor.remove(key)
            }
            editor.commit()
        }
    }

    @Test fun pairingAndSettingsArePanelsOnTheSameScene() {
        val activity = launch()
        try {
            val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
            val renderer = scene.getChildAt(0)
            click("Pair desktop")
            await { texts(activity.window.decorView).contains("Pair desktop") }
            instrumentation.runOnMainSync {
                assertTrue(texts(activity.window.decorView).contains("Scan pairing QR"))
                assertTrue(texts(activity.window.decorView).contains("Pair from clipboard"))
                assertSame(renderer, scene.getChildAt(0))
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, scene.importantForAccessibility)
            }
            click("Back")
            click("Settings")
            instrumentation.runOnMainSync {
                assertTrue(texts(activity.window.decorView).contains("Notification previews"))
                assertTrue(texts(activity.window.decorView).contains("Ringing invitations"))
                assertSame(renderer, scene.getChildAt(0))
            }
            click("Done")
            assertNull((context.applicationContext as Gateway).callVisual)
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun legacyMotionPreferencesBecomeOnePersistentChoice() {
        val stored = context.getSharedPreferences("screen", 0)
        val saved = stored.all
        try {
            for (reduced in listOf(false, true)) {
                stored.edit().remove("animations").putBoolean("reducedMotion", reduced)
                    .putBoolean("animateOverride", false).commit()
                assertEquals(!reduced, ScreenPreferences(context).animations)
                assertFalse(stored.contains("reducedMotion"))
                assertFalse(stored.contains("animateOverride"))
                ScreenPreferences(context).animations = true
                assertTrue(ScreenPreferences(context).animations)
            }
        } finally {
            val editor = stored.edit()
            for (key in listOf("animations", "reducedMotion", "animateOverride")) {
                val value = saved[key]
                if (value is Boolean) editor.putBoolean(key, value) else editor.remove(key)
            }
            editor.commit()
        }
    }

    @Test fun animationsControlBothRendererClocksWithoutReplacingTheScene() {
        check(BuildConfig.ISOLATED_INTEGRATION)
        val preferences = ScreenPreferences(context)
        val oldAnimations = preferences.animations
        val oldQuality = preferences.quality
        preferences.animations = true
        preferences.quality = 2
        val activity = launch()
        val app = context.applicationContext as Gateway
        val call = CallService(context, "animation-fixture", {}, {}, {})
        val callField = Gateway::class.java.getDeclaredField("call").apply { isAccessible = true }
        val render = InboxActivity::class.java.getDeclaredMethod("render").apply { isAccessible = true }
        try {
            val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
            val native = scene.getChildAt(0)
            // Register an active, unstarted call so the activity places its real panel lens.
            // No microphone, channel, or pairing credentials are opened.
            instrumentation.runOnMainSync {
                check(app.callVisual == null)
                callField.set(app, call)
                render.invoke(activity)
            }
            click("Settings")
            for (quality in listOf("2D", "GPU")) {
                click(quality)
                await { scene.voiceOverlay.isShown && scene.voiceOverlay.width > 0 }
                val renderer = if (quality == "2D")
                    descendants(scene.voiceOverlay).filterIsInstance<com.example.radiance.OrbFallback>().single()
                else descendants(scene.voiceOverlay).filterIsInstance<com.example.radiance.OrbSurface>().single()
                val clock = renderer.javaClass.getDeclaredField("elapsed").apply { isAccessible = true }
                fun time(): Float {
                    var result = 0f
                    instrumentation.runOnMainSync { result = clock.getFloat(renderer) }
                    return result
                }
                val moving = time()
                await { time() > moving }
                click("Animations")
                instrumentation.waitForIdleSync()
                val frozen = time()
                SystemClock.sleep(180)
                assertEquals("Motion continued with Animations off in $quality", frozen, time(), 0f)
                click("Animations")
                val restarted = time()
                await { time() > restarted }
                instrumentation.runOnMainSync { assertSame(native, scene.getChildAt(0)) }
            }
            click("Done")
        } finally {
            instrumentation.runOnMainSync {
                call.close()
                callField.set(app, null)
                activity.finish()
            }
            preferences.animations = oldAnimations
            preferences.quality = oldQuality
        }
    }

    @Test fun incomingInvitationUsesTheSceneWithoutRevealingTheQuestionOrStartingAudio() {
        check(BuildConfig.ISOLATED_INTEGRATION)
        val app = context.applicationContext as Gateway
        check(!app.paired && app.callVisual == null)
        val id = java.util.UUID.randomUUID().toString()
        instrumentation.runOnMainSync {
            app.store.state.pending[id] = Pending(id, "Private project", "Private invitation question", 1L)
        }
        val activity = instrumentation.startActivitySync(Intent(context, IncomingCallActivity::class.java)
            .putExtra(Invites.ID, id).putExtra("expiresAt", SystemClock.elapsedRealtime() + 45_000)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as IncomingCallActivity
        try {
            await { activity.hasWindowFocus() }
            instrumentation.runOnMainSync {
                val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
                assertEquals(0f, scene.energy(0f, 1), 0f)
                val shell = CallScreen::class.java.getDeclaredField("shell").apply { isAccessible = true }
                    .get(scene) as com.example.radiance.ShellMotion
                assertEquals("An invitation alone must not show the voice lens", 0f, shell.opacity, 0f)
                assertNull(app.callVisual)
                assertFalse(texts(activity.window.decorView).any { it.contains("Private invitation question") || it.contains("Private project") })
                for (label in listOf("Answer call", "Decline")) {
                    val action = descendants(activity.window.decorView).filterIsInstance<android.widget.Button>()
                        .single { it.text.toString() == label }
                    val visible = android.graphics.Rect()
                    assertTrue(action.getGlobalVisibleRect(visible))
                    assertEquals(action.height, visible.height())
                }
            }
        } finally {
            instrumentation.runOnMainSync { activity.finish(); app.store.state.pending.remove(id) }
        }
    }

    @Test fun verificationBackSurvivesRecreationAndRejectsSelfReturnPages() {
        val app = context.applicationContext as Gateway
        val emoji = Gateway::class.java.getDeclaredField("verifyEmoji").apply { isAccessible = true }
        val destination = InboxActivity::class.java.getDeclaredField("verificationReturn").apply { isAccessible = true }
        val render = InboxActivity::class.java.getDeclaredMethod("render").apply { isAccessible = true }
        for (savedReturn in listOf("REQUESTS", "NONE", "VERIFY")) {
            var activity = launch()
            // A test-only pairing challenge is re-delivered after recreation, without a transport or approval.
            val callbacks = object : android.app.Application.ActivityLifecycleCallbacks {
                override fun onActivityCreated(created: android.app.Activity, state: android.os.Bundle?) {
                    if (created is InboxActivity) emoji.set(app, "verification fixture")
                }
                override fun onActivityStarted(activity: android.app.Activity) = Unit
                override fun onActivityResumed(activity: android.app.Activity) = Unit
                override fun onActivityPaused(activity: android.app.Activity) = Unit
                override fun onActivityStopped(activity: android.app.Activity) = Unit
                override fun onActivitySaveInstanceState(activity: android.app.Activity, state: android.os.Bundle) = Unit
                override fun onActivityDestroyed(activity: android.app.Activity) = Unit
            }
            try {
                instrumentation.runOnMainSync {
                    emoji.set(app, "verification fixture")
                    render.invoke(activity)
                    destination.set(activity, destination.type.enumConstants!!.single { it.toString() == savedReturn })
                    app.registerActivityLifecycleCallbacks(callbacks)
                }
                activity = recreate(activity)
                await { texts(activity.window.decorView).contains("Verify desktop") }
                click("Back")
                instrumentation.runOnMainSync {
                    val expected = if (savedReturn == "REQUESTS") "Questions" else "Pair desktop"
                    assertTrue(texts(activity.window.decorView).contains(expected))
                    assertFalse(texts(activity.window.decorView).contains("Verify desktop"))
                    assertNull(app.callVisual)
                }
            } finally {
                instrumentation.runOnMainSync {
                    app.unregisterActivityLifecycleCallbacks(callbacks)
                    emoji.set(app, null)
                    activity.finish()
                }
            }
        }
    }

    @Test fun microphonePermissionAnswerSurvivesRecreationUntilItsResult() {
        var activity = launch()
        val pending = InboxActivity::class.java.getDeclaredField("permissionAnswer").apply { isAccessible = true }
        val requested = InboxActivity::class.java.getDeclaredField("answerRequested").apply { isAccessible = true }
        val resumed = InboxActivity::class.java.getDeclaredField("resumed").apply { isAccessible = true }
        val id = java.util.UUID.randomUUID().toString()
        try {
            instrumentation.runOnMainSync { pending.set(activity, id) }
            activity = recreate(activity)
            instrumentation.runOnMainSync {
                assertEquals(id, pending.get(activity))
                assertNull(requested.get(activity))
                assertNull((context.applicationContext as Gateway).callVisual)
                // Android can deliver permission results before onResume. The join must remain gated.
                resumed.setBoolean(activity, false)
                activity.onRequestPermissionsResult(1, arrayOf(android.Manifest.permission.RECORD_AUDIO),
                    intArrayOf(android.content.pm.PackageManager.PERMISSION_GRANTED))
                assertNull(pending.get(activity))
                assertEquals(id, requested.get(activity))
                assertNull((context.applicationContext as Gateway).callVisual)
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    private fun recreate(activity: InboxActivity): InboxActivity {
        val monitor = instrumentation.addMonitor(InboxActivity::class.java.name, null, false)
        try {
            instrumentation.runOnMainSync { activity.recreate() }
            val next = checkNotNull(monitor.waitForActivityWithTimeout(4000) as? InboxActivity) { "Activity was not recreated" }
            await { next.hasWindowFocus() }
            return next
        } finally { instrumentation.removeMonitor(monitor) }
    }

    private fun launch(): InboxActivity {
        check(BuildConfig.ISOLATED_INTEGRATION) { "Never run UI fixtures against the paired production install" }
        check(!(context.applicationContext as Gateway).paired) { "Requires an unpaired isolated install" }
        return (instrumentation.startActivitySync(Intent(context, InboxActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as InboxActivity).also { activity ->
            instrumentation.runOnMainSync { activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            await { activity.hasWindowFocus() }
        }
    }

    private fun secure(activity: InboxActivity): Boolean {
        var value = false
        instrumentation.runOnMainSync { value = activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0 }
        return value
    }

    private fun click(text: String) {
        var node: AccessibilityNodeInfo? = null
        await {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            val matches = root?.findAccessibilityNodeInfosByText(text).orEmpty()
                .filter { it.text?.toString()?.equals(text, ignoreCase = true) == true ||
                    it.contentDescription?.toString()?.equals(text, ignoreCase = true) == true }
            node = matches.firstOrNull { it.isVisibleToUser }
            if (node == null) {
                val target = matches.firstOrNull()
                if (target != null) target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                else root?.let { scrollable(it)?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) }
            }
            node != null
        }
        var target = checkNotNull(node)
        while (!target.isClickable) target = checkNotNull(target.parent)
        assertTrue("Could not click $text", target.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        instrumentation.waitForIdleSync()
    }

    private fun scrollable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isScrollable && node.isVisibleToUser) return node
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            scrollable(child)?.let { return it }
        }
        return null
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 4000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (predicate()) return
            SystemClock.sleep(30)
        }
        fail("Timed out waiting for Radiance UI")
    }

    private fun descendants(view: View): List<View> {
        val result = mutableListOf(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) result.addAll(descendants(view.getChildAt(index)))
        return result
    }
    private fun texts(view: View) = descendants(view).filterIsInstance<TextView>().map { it.text.toString() }
}
