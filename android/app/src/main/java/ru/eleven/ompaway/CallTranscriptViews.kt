package ru.eleven.ompaway

import android.view.View
import android.widget.TextView

/** Updates existing widgets without rebuilding call controls or persisting speech. */
internal class CallTranscriptViews(
    private val status: TextView,
    private val caller: TextView,
    private val assistant: TextView,
) {
    fun update(ready: Boolean, speaking: Boolean, callerText: String, callerFinal: Boolean, assistantText: String, assistantFinal: Boolean) {
        status.text = if (!ready) "Connecting audio…" else if (speaking) "Speaking…" else "Listening…"
        caller.visibility = if (callerText.isEmpty()) View.GONE else View.VISIBLE
        caller.text = (if (callerFinal) "You: " else "You (live): ") + callerText
        assistant.visibility = if (assistantText.isEmpty()) View.GONE else View.VISIBLE
        assistant.text = (if (assistantFinal) "Assistant: " else "Assistant (live): ") + assistantText
    }
}
