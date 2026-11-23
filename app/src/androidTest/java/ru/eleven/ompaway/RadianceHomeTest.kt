package ru.eleven.ompaway

import android.app.AlertDialog
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

    @Test fun radianceIsTheLaunchScreenAndInboxDoesNotReplaceItsRenderer() {
        val activity = launch()
        try {
            instrumentation.runOnMainSync {
                val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().singleOrNull()
                assertNotNull("Radiance must be visible before a voice call", scene)
                assertTrue(texts(activity.window.decorView).contains("R A D I A N C E"))
                assertEquals("Idle must not invent microphone energy", 0f, scene!!.energy(0f, 1), 0f)
            }
            val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
            val renderer = scene.getChildAt(0)
            click("Inbox")
            await { texts(activity.window.decorView).contains("Away inbox") }
            click("Back to Radiance")
            instrumentation.runOnMainSync {
                assertSame(scene, descendants(activity.window.decorView).filterIsInstance<CallScreen>().single())
                assertSame(renderer, scene.getChildAt(0))
                assertNull((context.applicationContext as Gateway).callVisual)
            }
            click("Inbox")
            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            await {
                activity.hasWindowFocus() && instrumentation.uiAutomation.rootInActiveWindow
                    ?.findAccessibilityNodeInfosByText("Back to Radiance")?.none { it.isVisibleToUser } == true
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    @Test fun appearanceControlsKeepTheRendererAndRestoreTheirPreferences() {
        val preferences = ScreenPreferences(context)
        val previousQuality = preferences.quality
        val previousReduced = preferences.reducedMotion
        val previousLight = preferences.lightBackdrop
        val activity = launch()
        try {
            val scene = descendants(activity.window.decorView).filterIsInstance<CallScreen>().single()
            val native = scene.getChildAt(0)
            click("Settings")
            click("2D")
            await { preferences.quality == 2 }
            instrumentation.runOnMainSync {
                assertTrue(descendants(scene).filterIsInstance<com.example.radiance.OrbFallback>().single().visibility == View.VISIBLE)
                assertSame(native, scene.getChildAt(0))
            }
            click("GPU")
            await { preferences.quality == 1 }
            instrumentation.runOnMainSync {
                assertTrue(native is com.example.radiance.OrbSurface && native.visibility == View.VISIBLE)
                assertSame(native, scene.getChildAt(0))
            }
            click("Reduced motion")
            await { preferences.reducedMotion != previousReduced }
            click("Reference backdrop")
            await { preferences.lightBackdrop != previousLight }
            click("Done")
            assertNull((context.applicationContext as Gateway).callVisual)
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            preferences.quality = previousQuality
            preferences.reducedMotion = previousReduced
            preferences.lightBackdrop = previousLight
        }
    }

    @Test fun screenshotSwitchAppliesImmediatelyToWindowsAndSurvivesRelaunch() {
        val preferences = context.getSharedPreferences("screen", 0)
        val previous = preferences.getBoolean("blockScreenshots", true)
        preferences.edit().remove("blockScreenshots").commit()
        var activity = launch()
        try {
            assertTrue(secure(activity))
            click("Settings")
            click("Block screenshots")
            await { !secure(activity) }
            instrumentation.runOnMainSync {
                val dialog = InboxActivity::class.java.getDeclaredField("settingsDialog").apply { isAccessible = true }
                    .get(activity) as AlertDialog
                assertEquals(0, dialog.window!!.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE)
            }
            click("Done")
            instrumentation.runOnMainSync { activity.finish() }
            instrumentation.waitForIdleSync()
            activity = launch()
            assertFalse("Screenshot choice was not persisted", secure(activity))
            click("Settings")
            click("Block screenshots")
            await { secure(activity) }
            click("Done")
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            preferences.edit().putBoolean("blockScreenshots", previous).commit()
        }
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
            node = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText(text)
                ?.firstOrNull { it.text?.toString()?.equals(text, ignoreCase = true) == true && it.isVisibleToUser }
            node != null
        }
        var target = checkNotNull(node)
        while (!target.isClickable) target = checkNotNull(target.parent)
        assertTrue("Could not click $text", target.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        instrumentation.waitForIdleSync()
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
