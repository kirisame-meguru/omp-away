package ru.eleven.ompaway

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import com.example.radiance.ShellMotion
import org.junit.Assert.*
import org.junit.Test

/** Visual state only: this fixture never creates media, a microphone, or a paired channel. */
class VoiceLensLifecycleTest {
    private class Source : CallVisualSource {
        override var active = true
        override var connected = false
        var input = 0f
        var output = 0f
        override fun microphoneLevel(nowMillis: Long) = input
        override fun playbackLevel() = output
    }

    @Test fun fullscreenSceneShowsOnlyActiveVoiceAndRetractsAcrossPauseAndRendererChanges() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val preferences = ScreenPreferences(context)
        val animations = preferences.animations
        val quality = preferences.quality
        val activity = instrumentation.startActivitySync(Intent(context, Activity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        lateinit var screen: CallScreen
        lateinit var shell: ShellMotion
        val source = Source()
        var created = false
        try {
            instrumentation.runOnMainSync {
                preferences.animations = true
                preferences.quality = 2
                screen = CallScreen(activity, null, {}, {})
                created = true
                shell = CallScreen::class.java.getDeclaredField("shell").apply { isAccessible = true }.get(screen) as ShellMotion
                activity.setContentView(screen)
                screen.resume()
                assertEquals(0f, shell.opacity, 0f)
                assertEquals(0f, screen.energy(0f, 1), 0f)
            }
            await { screen.width > 0 && screen.height > 0 }
            instrumentation.runOnMainSync {
                assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, screen.layoutParams.height)
                assertEquals(screen.height, screen.getChildAt(0).height)
                screen.bind(source)
            }
            await { shell.opacity > .99f && texts(screen).contains("Connecting audio…") }
            instrumentation.runOnMainSync { source.connected = true; source.input = .5f }
            await { shell.height > .99f && texts(screen).contains("Listening…") && screen.energy(0f, 1) > 0f }
            instrumentation.runOnMainSync {
                source.input = 0f
                screen.captions("A caller turn", true, "", false)
            }
            await { texts(screen).contains("Thinking…") && shell.height < .3f }
            instrumentation.runOnMainSync { source.output = .5f }
            await { texts(screen).contains("Speaking…") && shell.width > 1f }
            instrumentation.runOnMainSync { source.output = 0f }
            await { texts(screen).contains("Listening…") }
            var dismissed = false
            instrumentation.runOnMainSync {
                source.active = false
                screen.dismiss { screen.bind(null); dismissed = true }
            }
            await { dismissed && shell.opacity == 0f }
            instrumentation.runOnMainSync {
                assertEquals(0f, screen.translationY, 0f)
                assertEquals(screen.height, screen.getChildAt(0).height)
                source.active = true
                screen.bind(source)
            }
            await { shell.opacity > .5f }
            instrumentation.runOnMainSync {
                screen.pause()
                source.active = false
                screen.bind(null)
                screen.resume()
                assertEquals("No old lens may return after a background call ends", 0f, shell.opacity, 0f)
                preferences.quality = 1
                preferences.animations = false
                screen.refreshAppearance()
                assertEquals(0f, shell.opacity, 0f)
                source.active = true
                screen.bind(source)
                assertEquals("Reduced motion must show the current active pose immediately", 1f, shell.opacity, 0f)
                screen.dismiss { screen.bind(null) }
                assertEquals("Reduced motion must retract immediately", 0f, shell.opacity, 0f)
            }
        } finally {
            instrumentation.runOnMainSync {
                if (created) screen.dispose()
                activity.finish()
                preferences.animations = animations
                preferences.quality = quality
            }
        }
    }

    private fun await(predicate: () -> Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = SystemClock.elapsedRealtime() + 4000
        while (SystemClock.elapsedRealtime() < deadline) {
            var done = false
            instrumentation.runOnMainSync { done = predicate() }
            if (done) return
            SystemClock.sleep(20)
        }
        fail("Voice lens did not reach its expected pose")
    }

    private fun texts(view: View): List<String> = when (view) {
        is TextView -> listOf(view.text.toString())
        is ViewGroup -> (0 until view.childCount).flatMap { texts(view.getChildAt(it)) }
        else -> emptyList()
    }
}
