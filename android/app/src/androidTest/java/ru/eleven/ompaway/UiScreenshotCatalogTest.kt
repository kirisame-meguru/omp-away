package ru.eleven.ompaway

import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import ru.eleven.ompaway.UiCatalogFixture.Companion.put

/** Run only in the isolated integration package. All exported content is deliberately synthetic. */
class UiScreenshotCatalogTest {
    @Test fun captureCatalog() {
        check(BuildConfig.ISOLATED_INTEGRATION) { "Catalog is forbidden in the normal application package" }
        val fixture = UiCatalogFixture(InstrumentationRegistry.getInstrumentation(), InstrumentationRegistry.getArguments())
        try {
            fixture.start()
            inbox(fixture)
            forms(fixture)
            pairing(fixture)
            settings(fixture)
            calls(fixture)
            fixture.incoming()
            fixture.finish()
        } catch (error: Throwable) {
            fixture.failed(error)
            throw error
        } finally { fixture.close() }
    }

    private fun inbox(f: UiCatalogFixture) {
        f.scenario("requests-unpaired-empty", "REQUESTS", "Unpaired, offline, no cached questions; normal appearance defaults")
        f.scenario("requests-paired-offline", "REQUESTS", "Synthetic paired vault, offline", { f.paired() })
        f.scenario("requests-awaiting-sync", "REQUESTS", "Cached pending data withheld before authenticated sync", {
            f.paired(); pending(f); f.app.forms[id] = richForm()
            put(f.app, "statusMessage", UiMessage(R.string.refreshing_inbox))
        })
        f.scenario("requests-connected-empty", "REQUESTS", "Connected visual state, empty inbox", { f.connected() })
        f.scenario("requests-multiple-silenced-missed", "REQUESTS", "Multiple pending, silenced and missed invitations", {
            f.connected()
            repeat(3) { index ->
                val request = requestId(index + 1)
                f.app.store.state.pending[request] = Pending(request, "Catalog project ${index + 1}", "Review synthetic change ${index + 1}.", timestamp + index * 60_000L, "Catalog session ${index + 1}")
                f.app.forms[request] = compactForm()
            }
            f.app.store.state.silenced.add(requestId(2))
            f.app.store.state.invited.addAll(listOf(requestId(4), requestId(5)))
            f.app.store.state.silenced.add(requestId(5))
        })
        f.scenario("requests-answer-accepted", "REQUESTS", "Synthetic accepted receipt after request removal", {
            f.connected(); put(f.app, "answerReceipt", "Answer accepted by desktop.")
        })
        f.scenario("requests-answer-stale", "REQUESTS", "Synthetic stale receipt after question closure", {
            f.connected(); put(f.app, "answerReceipt", "This question is no longer pending.")
        })
        f.scenario("details-closed", "DETAILS", "Selected request no longer pending", { f.connected(); f.select(id) })
        f.scenario("details-awaiting-sync", "DETAILS", "Selected invitation not yet synchronized", { f.paired(); f.select(id) })
        f.scenario("details-cached-offline", "DETAILS", "Private cached form and legacy content withheld while offline", {
            f.paired(); pending(f); f.select(id); f.app.forms[id] = richForm(); legacy(f)
        })
        f.scenario("requests-voice-error", "REQUESTS", "Synthetic audio setup failure message, no media attempted", {
            f.connected(); pending(f); f.app.forms[id] = compactForm()
            put(f.app, "statusMessage", UiMessage(R.string.voice_did_not_become_ready_request_remains_pending))
        })
        f.scenario("requests-microphone-unavailable", "REQUESTS", "Touch remains available after a synthetic microphone-denied notice", {
            f.connected(); pending(f); f.app.forms[id] = compactForm()
            put(f.activity, "notice", "Microphone unavailable. You can still answer by touch.")
        })
    }

    private fun forms(f: UiCatalogFixture) {
        for (page in listOf("REQUESTS", "DETAILS")) {
            val suffix = if (page == "REQUESTS") "home" else "details"
            f.scenario("form-loading-$suffix", page, "Loading form; fetch suppressed by fixture loading set", {
                f.connected(); pending(f); f.select(id); f.loading(id)
            })
            f.scenario("form-unavailable-$suffix", page, "Null touch form receipt with legacy display fallback", {
                f.connected(); pending(f); f.select(id); legacy(f)
                f.app.formMessages[id] = "Touch answers are unavailable for this question. Review details or use voice."
            })
            f.scenario("form-malformed-$suffix", page, "Malformed schema, production fallback presentation", {
                f.connected(); pending(f); f.select(id); legacy(f); f.app.forms[id] = JSONObject("""{"sections":[{"blocks":[{"kind":"field","field":{}}]}]}""")
            })
            f.scenario("form-rich-$suffix", page, "Required text, multiline, number, choice, multiple choice, disabled option, formatting and horizontal table/code scrolling", {
                form(f, richForm())
            })
        }
        f.scenario("form-empty-schema", "DETAILS", "Completely empty form falls back to legacy details", {
            form(f, JSONObject("""{"sections":[]}""")); legacy(f)
        })
        f.scenario("form-text-only", "DETAILS", "Intentional authored text-only form", {
            form(f, JSONObject().put("title", "Read this context").put("sections", JSONArray().put(section("", JSONArray().put(text("This is an intentional text-only form. It remains visible without inventing fields."))))))
        })
        f.scenario("form-metadata-only", "DETAILS", "Intentional metadata-only form", {
            form(f, JSONObject("""{"title":"Context only","description":"A separate synthetic explanation.","sections":[]}"""))
        })
        f.scenario("form-drafts-other-notes", "DETAILS", "Restored text/multi/Other drafts and expanded per-option notes", {
            form(f, richForm())
            f.app.drafts[id] = JSONObject().put("reason", "A saved synthetic draft.").put("detail", "First line of a saved draft.\nSecond line remains editable.")
                .put("count", "3").put("decision", "A custom catalog option").put("areas", JSONArray(listOf("layout", "accessibility")))
            f.app.noteDrafts[id] = JSONArray().put(note("decision", "A custom catalog option", "Explain the alternative without submitting it."))
                .put(note("areas", "layout", "Check the entire scroll range."))
        })
        f.scenario("form-option-notes-expanded", "DETAILS", "Native note toggles opened; no answer submitted", {
            form(f, compactForm().put("optionNotes", true))
        }, {
            f.views().filterIsInstance<Button>().filter { it.text.toString().startsWith("Note:") && it.isShown }.forEach { it.performClick() }
            f.views().filterIsInstance<EditText>().filter { it.contentDescription?.toString()?.startsWith("Note for") == true }
                .forEach { it.setText("Synthetic option note for layout review.") }
        })
        f.scenario("form-other-expanded", "DETAILS", "Native Other selection and editable custom text", {
            form(f, compactForm())
        }, {
            f.views().filterIsInstance<CompoundButton>().single { it.text.toString() == "Other" }.performClick()
            f.views().filterIsInstance<EditText>().single { it.hint?.toString() == "Your answer" }.setText("Another synthetic choice")
        })
        f.scenario("form-required-validation", "DETAILS", "Native local required validation; activity submission gate remains false", {
            form(f, richForm())
        }, {
            f.views().filterIsInstance<Button>().single { it.text.toString() == "Submit answer" }.performClick()
        })
        f.scenario("form-min-length-validation", "DETAILS", "Native minimum length error", {
            form(f, richForm()); f.app.drafts[id] = JSONObject().put("reason", "x").put("count", "3")
        }, {
            f.views().filterIsInstance<Button>().single { it.text.toString() == "Submit answer" }.performClick()
        })
        f.scenario("form-max-length-validation", "DETAILS", "Native maximum length error", {
            form(f, richForm()); f.app.drafts[id] = JSONObject().put("reason", "A".repeat(121)).put("count", "3")
        }, {
            f.views().filterIsInstance<Button>().single { it.text.toString() == "Submit answer" }.performClick()
        })
        for ((label, value) in listOf("minimum" to "0", "maximum" to "99")) {
            f.scenario("form-numeric-$label-validation", "DETAILS", "Native numeric $label error after valid preceding fields", {
                form(f, richForm()); f.app.drafts[id] = JSONObject().put("reason", "Valid synthetic explanation").put("count", value)
            }, {
                f.views().filterIsInstance<Button>().single { it.text.toString() == "Submit answer" }.performClick()
            })
        }
        f.scenario("form-other-validation", "DETAILS", "Native empty Other validation", {
            form(f, compactForm())
        }, {
            f.views().filterIsInstance<CompoundButton>().single { it.text.toString() == "Other" }.performClick()
            f.views().filterIsInstance<Button>().single { it.text.toString() == "Submit answer" }.performClick()
        })
        for ((name, message) in linkedMapOf(
            "submitting" to "Submitting…",
            "uncertain" to "Submission not confirmed. Check the desktop before retrying.",
            "invalid" to "Choose an answer before submitting.",
            "busy" to "The desktop is processing another answer. Try again later.",
            "send-error" to "Answer was not sent. Check the connection or shorten your text."
        )) f.scenario("form-$name", "DETAILS", "Synthetic answer status: $name; no real submission", {
            form(f, compactForm()); f.app.formMessages[id] = message
            if (name == "submitting" || name == "uncertain") f.app.submitting.add(id)
        })
        f.scenario("form-long-content", "DETAILS", "Long authored text, multiline input, repeating paragraphs and a wide table", { form(f, richForm(long = true)) })
        f.scenario("form-keyboard", "DETAILS", "Actual Android IME focused on a synthetic native editor", { form(f, keyboardForm()) }, { f.keyboard() })
        f.scenario("form-text-selection", "DETAILS", "Actual Android editor selection/context menu on synthetic content", {
            form(f, keyboardForm())
        }, { f.selectionMenu() })
        f.scenario("form-input-types", "DETAILS", "Production email, URL, date and range native editors", {
            val blocks = JSONArray()
            for (type in listOf("email", "url", "date", "range")) blocks.put(field(JSONObject().put("kind", "text").put("name", type)
                .put("question", "Synthetic $type input").put("type", type).put("placeholder", "Enter $type")))
            form(f, JSONObject().put("sections", JSONArray().put(section("Input types", blocks))))
        })
        f.scenario("form-touch-only", "DETAILS", "Voice disabled by schema; touch remains authoritative", { form(f, compactForm().put("voice", false)) })
        f.scenario("details-active-call-proposal", "DETAILS", "Synthetic never-started call object, proposal and production transcript cards; no audio focus or media", {
            form(f, compactForm()); f.activeCall(id)
            f.app.store.state.proposals[id] = "Select the first option after reviewing the explanation. This is only a proposal."
        })
        f.scenario("form-busy-ending-call", "DETAILS", "Touch controls disabled during the synthetic call-ending interval", {
            form(f, compactForm()); put(f.app, "endingId", id)
        })
    }

    private fun pairing(f: UiCatalogFixture) {
        f.scenario("pairing-unpaired", "PAIRING", "Initial unpaired page")
        f.scenario("pairing-in-progress", "PAIRING", "Synthetic enrollment progress; no invitation consumed", {
            put(f.app, "pairing", true); put(f.app, "statusMessage", UiMessage(R.string.verifying_desktop_identity))
        })
        f.scenario("pairing-verification", "VERIFY", "Synthetic twelve-emoji verification layout; no confirmation action", {
            put(f.app, "pairing", true); put(f.app, "verifyEmoji", "\u2600\uFE0F \u2601\uFE0F \u2602\uFE0F \u2615 \u26BD \u26C4 \u26F5 \u2708\uFE0F \u2728 \u2764\uFE0F \uD83C\uDF08 \uD83C\uDF34")
        })
        f.scenario("pairing-mismatch", "PAIRING", "Synthetic rejected verification notice; no pairing/network operation", {
            put(f.app, "statusMessage", UiMessage(R.string.pairing_declined))
        })
        f.scenario("pairing-invalid-clipboard", "PAIRING", "Synthetic clipboard validation notice; clipboard is never read", {
            put(f.activity, "notice", "Copy the desktop pairing JSON first.")
        })
        f.scenario("pairing-scan-cancelled", "PAIRING", "Synthetic scanner cancellation notice; camera is never opened", {
            put(f.activity, "notice", "No pairing code read. Check camera permission or use the clipboard.")
        })
        f.scenario("pairing-paired-offline", "PAIRING", "Synthetic existing desktop pairing, reconnect control", { f.paired() })
        f.scenario("pairing-relay-recovery", "PAIRING", "Synthetic legacy vault without relay origin", {
            f.paired(legacy = true); put(f.app, "statusMessage", UiMessage(R.string.relay_setup_required_pairing_keys_have_been_retained))
        })
        f.scenario("requests-relay-recovery", "REQUESTS", "Restore-relay entry point on home", { f.paired(legacy = true) })
        f.scenario("relay-entry", "RELAY", "Trusted origin entry and warning; no credential is sent", { f.paired(legacy = true) })
        f.scenario("relay-rejected", "PAIRING", "Synthetic relay recovery rejection", {
            f.paired(legacy = true); put(f.app, "statusMessage", UiMessage(R.string.enter_a_valid_https_relay_origin_without_credentials_path_query))
        })
    }

    private fun settings(f: UiCatalogFixture) {
        f.scenario("settings-baseline", "SETTINGS", "Observed baseline: animations on, reference on, Auto, block screenshots off, previews off, ringing off")
        f.scenario("settings-active-call", "SETTINGS", "Production settings panel over a never-started synthetic call object", {
            form(f, compactForm()); f.activeCall(id)
        })
        for ((quality, label) in listOf(0 to "auto", 1 to "gpu", 2 to "2d")) {
            f.scenario("settings-renderer-$label", "SETTINGS", "Production $label radio selection", {
                f.preferences().quality = quality; f.screen.refreshAppearance()
            })
        }
        f.scenario("settings-reduced-motion", "SETTINGS", "Production Animations off selection", {
            f.preferences().animations = false; f.screen.refreshAppearance()
        })
        f.scenario("settings-dark-backdrop", "SETTINGS", "Production Reference backdrop off selection", {
            f.preferences().lightBackdrop = false; f.screen.refreshAppearance()
        })
        f.scenario("settings-previews-ringing-enabled", "SETTINGS", "Synthetic notification preferences enabled; no notification is posted", {
            f.app.inviteSettings.apply { showPreview = true; callMode = true }
        })
        f.scenario("settings-privacy-enabled", "SETTINGS", "Checked Block screenshots control from fixture prefs; host remains intentionally capture-enabled, not a FLAG_SECURE test", {
            f.preferences().blockScreenshots = true
        })
        for (quality in listOf(1, 2)) for (light in listOf(true, false)) for (motion in listOf(true, false)) {
            f.scenario("appearance-${if (quality == 1) "gpu" else "2d"}-${if (light) "reference" else "dark"}-${if (motion) "animated" else "still"}",
                "REQUESTS", "Home scene appearance combination", {
                    f.connected(); pending(f); f.app.forms[id] = compactForm()
                    f.preferences().apply { this.quality = quality; lightBackdrop = light; animations = motion }; f.screen.refreshAppearance()
                })
        }
    }

    private fun calls(f: UiCatalogFixture) {
        for ((renderer, label) in listOf(1 to "gpu", 2 to "2d")) {
            f.voice("voice-$label-idle", renderer, false, false, 0f, 0f)
            f.voice("voice-$label-connecting", renderer, true, false, 0f, 0f)
            f.voice("voice-$label-listening", renderer, true, true, .45f, 0f)
            f.voice("voice-$label-quiet-listening", renderer, true, true, 0f, 0f)
            f.voice("voice-$label-thinking", renderer, true, true, 0f, 0f, "Please review this synthetic proposal.", true)
            f.voice("voice-$label-speaking", renderer, true, true, 0f, .65f,
                "Please review this synthetic proposal.", true, "Here is a synthetic explanation. Nothing has been submitted.", false)
            f.voice("voice-$label-captions-final", renderer, true, true, 0f, 0f,
                "I selected the first catalog option.", true, "Review the question before confirming an answer.", true)
            f.voice("voice-$label-captions-long", renderer, true, true, .2f, 0f,
                (1..12).joinToString(" ") { "Synthetic caller sentence $it for transcript scrolling." }, false,
                (1..12).joinToString(" ") { "Synthetic assistant sentence $it, not a submitted answer." }, false)
            f.voice("voice-$label-disconnected", renderer, false, false, 0f, 0f, "A synthetic interrupted phrase", false)
            f.voice("voice-$label-caller-takeover", renderer, true, true, .65f, 0f,
                "Wait, I would like to clarify", false, "The previous synthetic response was", false)
            f.voice("voice-$label-ending", renderer, true, true, 0f, 0f, dismissing = true)
            f.voice("voice-$label-ended", renderer, false, false, 0f, 0f, "A complete synthetic statement.", true)
            f.voice("voice-$label-panel-overlay", renderer, true, true, .5f, 0f,
                caller = "Please review this option while I keep the question open.", callerFinal = true,
                assistant = "These live captions are not a submitted answer.", assistantFinal = true,
                panel = true, panelForm = compactForm())
            f.voice("voice-$label-speaker-on", renderer, true, true, 0f, 0f, speakerOn = true)
            for (light in listOf(true, false)) for (motion in listOf(true, false)) {
                f.voice("voice-$label-speaking-${if (light) "reference" else "dark"}-${if (motion) "animated" else "still"}",
                    renderer, true, true, 0f, .65f, assistant = "Synthetic caption over the visual scene.", motion = motion, light = light)
            }
        }
    }

    private fun pending(f: UiCatalogFixture) {
        f.app.store.state.pending[id] = Pending(id, "Catalog project", "Review the synthetic question.", timestamp, "Catalog session")
    }
    private fun form(f: UiCatalogFixture, schema: JSONObject) { f.connected(); pending(f); f.select(id); f.app.forms[id] = schema }
    private fun legacy(f: UiCatalogFixture) {
        f.app.store.state.details[id] = QuestionDisplay(1, "Synthetic legacy context. This display is read-only.", listOf(
            DisplayField("f1", "Choose a legacy option", "single", true, other = true, options = listOf(
                DisplayOption("o1", "First legacy option", false), DisplayOption("o2", "Disabled legacy option", true))),
            DisplayField("f2", "Select applicable areas", "multi", false, options = listOf(DisplayOption("o1", "Layout", false))),
            DisplayField("f3", "Add a legacy explanation", "text", false, description = "Answer on the desktop or use voice.", placeholder = "Read-only input description")
        ))
    }

    private fun compactForm() = JSONObject("""{"title":"Review the synthetic question.","optionNotes":true,"voice":true,"sections":[
        {"title":[{"text":"Review the synthetic question."}],"blocks":[{"kind":"field","field":{
            "kind":"choice","name":"decision","question":"Review the synthetic question.","required":true,"other":true,"options":[
                {"value":"first","label":[{"text":"First option"}],"checked":true},
                {"value":"second","label":[{"text":"Second option"}]},
                {"value":"unavailable","label":[{"text":"Unavailable option"}],"disabled":true}]}}]}]}""")

    private fun keyboardForm() = JSONObject().put("title", "Keyboard and editor layout").put("sections", JSONArray().put(section("", JSONArray().put(field(
        JSONObject().put("kind", "text").put("name", "reason").put("question", "Synthetic explanation").put("required", true)
            .put("placeholder", "Enter a synthetic explanation").put("multiline", true).put("rows", 4)
    )))))

    private fun richForm(long: Boolean = false): JSONObject {
        val blocks = JSONArray().put(JSONObject().put("kind", "text").put("spans", JSONArray()
            .put(JSONObject().put("text", "Synthetic context: ").put("style", "strong"))
            .put(JSONObject().put("text", "preserve authored emphasis ").put("style", "em"))
            .put(JSONObject().put("text", "and_code_formatting").put("style", "code"))))
        if (long) repeat(16) { blocks.put(text("Paragraph ${it + 1}. " + "This deliberately long synthetic context checks wrapping and complete scroll coverage. ".repeat(4))) }
        blocks.put(JSONObject().put("kind", "list").put("ordered", true).put("items", JSONArray().put(spans("Inspect the question.")).put(spans("Review all available options."))))
        blocks.put(JSONObject().put("kind", "pre").put("text", "synthetic_example --first-option --second-option --third-option --long-horizontal-content-for-scrolling"))
        val rows = JSONArray().put(JSONArray().put(spans("Synthetic heading A")).put(spans("Synthetic heading B")).put(spans("Synthetic heading C")))
            .put(JSONArray().put(spans("First cell")).put(spans("Second cell")).put(spans("Third cell")))
        blocks.put(JSONObject().put("kind", "table").put("headerRows", 1).put("rows", rows))
        blocks.put(JSONObject().put("kind", "image").put("alt", "Synthetic image description"))
        blocks.put(JSONObject().put("kind", "svg").put("alt", "Synthetic diagram description"))
        blocks.put(field(JSONObject().put("kind", "text").put("name", "reason").put("question", "Explain your choice")
            .put("required", true).put("minLength", 4).put("maxLength", 120).put("placeholder", "At least four characters")))
        blocks.put(field(JSONObject().put("kind", "text").put("name", "detail").put("question", "Additional context")
            .put("multiline", true).put("rows", 4).put("placeholder", "Optional multiline text")))
        blocks.put(field(JSONObject().put("kind", "text").put("name", "count").put("question", "Number of examples")
            .put("type", "number").put("min", 1).put("max", 5).put("placeholder", "Between one and five")))
        val choice = compactForm().getJSONArray("sections").getJSONObject(0)
        val multi = JSONObject("""{"kind":"choice","name":"areas","question":"Which areas need review?","multi":true,"array":true,"other":true,"options":[
            {"value":"layout","label":[{"text":"Layout"}],"checked":true},
            {"value":"accessibility","label":[{"text":"Accessibility"}]},
            {"value":"contrast","label":[{"text":"Contrast and wrapping for a deliberately longer option label"}]}]}""")
        return JSONObject().put("title", "Synthetic review form").put("description", "All content in this capture is synthetic.")
            .put("optionNotes", true).put("voice", true).put("sections", JSONArray().put(section("Review context", blocks))
                .put(choice).put(section("Which areas need review?", JSONArray().put(field(multi)))))
    }

    private fun note(name: String, value: String, text: String) = JSONObject().put("name", name).put("value", value).put("text", text)
    private fun field(value: JSONObject) = JSONObject().put("kind", "field").put("field", value)
    private fun spans(value: String) = JSONArray().put(JSONObject().put("text", value))
    private fun text(value: String) = JSONObject().put("kind", "text").put("spans", spans(value))
    private fun section(title: String, blocks: JSONArray) = JSONObject().put("title", if (title.isEmpty()) JSONArray() else spans(title)).put("blocks", blocks)
    private fun requestId(index: Int) = "00000000-0000-4000-8000-${index.toString().padStart(12, '0')}"
    private val id = requestId(1)
    private val timestamp = 1_700_000_000_000L
}
