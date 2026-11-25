package ru.eleven.ompaway

import android.view.View
import android.widget.TextView

/** Updates existing widgets without rebuilding call controls or persisting speech. */
internal class CallTranscriptViews(
    private val status: TextView,
    private val caller: TextView,
    private val assistant: TextView,
) {
    fun update(ready: Boolean, speaking: Boolean, callerText: String, callerFinal: Boolean, assistantText: String,
               assistantFinal: Boolean, thinking: Boolean = false) {
        status.text = if (!ready) status.context.uiString(R.string.connecting_audio) else if (speaking) status.context.uiString(R.string.speaking) else if (thinking) status.context.uiString(R.string.thinking) else status.context.uiString(R.string.listening)
        caller.visibility = if (callerText.isEmpty()) View.GONE else View.VISIBLE
        caller.text = (if (callerFinal) status.context.uiString(R.string.you) else status.context.uiString(R.string.you_live)) + callerText
        assistant.visibility = if (assistantText.isEmpty()) View.GONE else View.VISIBLE
        assistant.text = (if (assistantFinal) status.context.uiString(R.string.assistant) else status.context.uiString(R.string.assistant_live)) + assistantText
    }
}
