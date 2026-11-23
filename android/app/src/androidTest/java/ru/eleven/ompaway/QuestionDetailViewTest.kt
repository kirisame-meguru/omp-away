package ru.eleven.ompaway

import android.content.res.Configuration
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class QuestionDetailViewTest {
    private fun labels(view: View): List<TextView> = if (view is TextView) listOf(view)
        else if (view is ViewGroup) (0 until view.childCount).flatMap { labels(view.getChildAt(it)) } else emptyList()

    @Test fun readOnlyChoicesScrollAtLargeTextAndRetainDistinctAccessibleIdentities() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        instrument.runOnMainSync {
            val config = Configuration(instrument.targetContext.resources.configuration).apply { fontScale = 2f }
            val context = instrument.targetContext.createConfigurationContext(config)
            val view = QuestionDetailView(context)
            val long = "日本語 — a long choice ".repeat(100)
            val display = QuestionDisplay(1, "Context", listOf(
                DisplayField("f0", "Choose several", "multi", true, "Description", true,
                    options = listOf(DisplayOption("o0", long, false), DisplayOption("o1", long, true))),
                DisplayField("f1", "Explain", "text", false, placeholder = "Other details")
            ))
            view.bind(Pending("one", "Project", "Summary", 1), display, true)
            view.measure(View.MeasureSpec.makeMeasureSpec(360, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(220, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, 360, 220)
            assertTrue(view.getChildAt(0).measuredHeight > view.height)
            val texts = labels(view)
            val background = android.graphics.Color.luminance(0xff181824.toInt())
            assertTrue("Question text must contrast with the Radiance inbox", texts.all {
                (android.graphics.Color.luminance(it.currentTextColor) + .05f) / (background + .05f) >= 4.5f
            })
            assertTrue(texts.any { it.text.contains("Unavailable") })
            assertTrue(texts.any { it.text.contains("Other") })
            assertTrue(texts.any { it.text.contains("Select multiple") })
            assertTrue(texts.any { it.text.contains("Required") })
            assertTrue(texts.all { !it.isClickable })
            assertEquals(2, texts.filter { it.tag == "one/f0/o0" || it.tag == "one/f0/o1" }.size)
            assertTrue(texts.filter { it.tag == "one/f0/o0" || it.tag == "one/f0/o1" }.all { it.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_YES })
            view.bind(Pending("two", "Project", "Second question", 2), null, true)
            assertFalse(labels(view).any { it.text.contains(long) })
            assertTrue(labels(view).any { it.text.contains("Summary only") })
            view.bind(Pending("two", "Project", "Second question", 2), display, false)
            assertFalse(labels(view).any { it.text.contains(long) })
            assertTrue(labels(view).any { it.text.contains("Pending sync") })
        }
    }
}
