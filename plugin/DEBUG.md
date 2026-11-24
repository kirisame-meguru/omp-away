# Stock interactive Ask integration gate

**Verified 2026-11-22:** a stock Windows omp 19.1.0 TUI in an isolated ConPTY/profile rendered all three forms. The scripted provider observed `blue/guest proof`, `green/desktop proof`, `green/desktop proof`; each had exactly one agent start/end, presentation and successful native Ask end. All four stale replays were rejected, and the normal composer returned after submission. Both module suites passed (34 tests) and `bun check` passed with Bun 1.4.4. This verifies the local Ask bridge only, not Android or Codex audio.

## Start an isolated host

Prerequisites: stock `omp` **19.1.0** on PATH, Bun **1.4.4+**, and a private local directory in which to create a fresh profile. On Windows x64 with Bun 1.4.2, bootstrap the [1.4.4 executable](https://unpkg.com/@oven/bun-windows-x64@1.4.4/?meta) **under the plugin repo only** (PowerShell, from this repo):

```powershell
npm install --prefix .tools --no-save --ignore-scripts --no-package-lock @oven/bun-windows-x64@1.4.4
$env:Path = (Resolve-Path .tools/node_modules/@oven/bun-windows-x64/bin).Path + ';' + $env:Path
bun --version  # expect 1.4.4
```

Only this shell's PATH changes; repeat the PATH line in terminal two before `confirm.ts`. Skip the bootstrap when a supported Bun is already on PATH. Then:

```powershell
bun install
$root = Join-Path $env:TEMP ('away-ask-' + [guid]::NewGuid())
Write-Host $root                 # copy this path into a second terminal
bun test/fixtures/launch.ts $root 18475
```

Use another free port if needed. The launcher refuses an existing root, creates a fresh work directory, home, `PI_CONFIG_DIR` and `away-fixture` named profile, and links the package into that profile only. It launches a real interactive `omp` with an allowlisted environment, explicit extension paths, `--tools ask`, and a scripted in-process model provider. The package's [19.1.0 loader convention](https://unpkg.com/@oh-my-pi/pi-coding-agent@19.1.0/src/extensibility/extensions/directory-resolution.ts) is `package.json#omp.extensions`; the fixture provider is **not** in that manifest. The fixture produces model events only; the real host issues the tool call, executes Ask, draws the form, owns the room and returns the answer to the model.

Wait for **Away: local guest ready** before issuing any prompt. Readiness requires `collab.relayUrl: ws://127.0.0.1:<port>`, `collab.autoStart: control`, and `ask.timeout: 0`. Do not run `/collab` or print a link. On an unavailable notification, correct the isolated profile/port and restart fresh; do not enter a real credential or inspect another profile.

## Guest wins, then desktop wins

Use a second terminal in the plugin repository, setting `$root` to the **same** path that the launcher created. All `confirm.ts` invocations explicitly target one ordinal; none means “answer whichever form is active.” Each one sends the fixed test submission `{ "mode": "blue", "note": "guest proof" }` after operator confirmation. The mailbox is test-only and cannot send Collab frames or prompts.

1. In the TUI, type `away fixture` as a user message. Verify a real form shows **Choose the test lane** and **Test note**, with the selected default **Green lane**. Leave the form untouched. Wait for `$root/mail/ask-1.json` (the actual tagged first guest field is now bound).
2. In terminal two: `bun test/fixtures/confirm.ts $root 1`. Require `accepted`, the form gone, the original Ask completed, and **Fixture received the native Ask result.** visible. The model-facing data must say **blue**, not **Blue lane**. Repeat the same command: require `stale`, with no extra turn.
3. In the TUI, type `away fixture` again. Wait for `$root/mail/ask-2.json`. Repeat `bun test/fixtures/confirm.ts $root 1` against the *previous* Ask. Require `stale`; the second native form must still be open and unmodified.
4. Finish Ask 2 **on the desktop**, leaving **Green lane** selected, entering `desktop proof` in **Test note**, then activating the form's **Submit** (use the form's displayed navigation hints). Require the form gone, native Ask completed, and the fixture's completion message. Run `bun test/fixtures/confirm.ts $root 2`: require `stale`.
5. For the desktop-win replay against a live successor, send `away fixture` once more, wait for `$root/mail/ask-3.json`, then run `bun test/fixtures/confirm.ts $root 2`. Require `stale`; Ask 3 must remain open on its default selection. Complete Ask 3 on the desktop with `desktop proof` and submit.

```powershell
Get-Content (Join-Path $root 'mail/trace.ndjson')
```

Across the three deliberate user messages, require exactly **three** `agent_start`, `presented`, `ask_execution_end` (`ok`), `provider_received_native_values`, and `agent_end` records of each kind. Model-observed values, in order: `blue/guest proof`, `green/desktop proof`, `green/desktop proof`. No `unexpected` or `error`. A native execution end without the subsequent model observation is not sufficient. Also check the TUI after each completion: a normal composer is back, and there is no outstanding dialog or injected user message. Exit the isolated host with `/exit`.

## Host delivery boundary

Only when **no gateway settings** are present, a trusted in-process local fixture may listen on `pi.events.on("omp-away:pending-ask", ...)`. With a gateway configured, the extension passes the capability directly to the session coordinator; it never publishes it on the event bus. `PendingAsk` contains original `html`, `requestId`, `toolCallId` and `submitConfirmed(requestId, values)`. Never serialize this function or expose it as an agent tool. Unrelated dialogs and approvals are ineligible. An old capability cannot affect a later Ask. `accepted` requires dispatch of the confirmed guest steps **and** an exact match to this call's native result; the host cannot distinguish identical desktop and phone submissions. The fixture uses distinct values and deliberate ordering for that reason.

## Connect an actual phone

Use stock interactive omp 19.1.0 main sessions, the normal desktop Codex login, Bun 1.4.4+, a CA-trusted HTTPS gateway, and two preprovisioned Python environments. Sessions on the same desktop share the paired gateway, not their model context or native submission authority. The isolated scripted fixture above deliberately has **no gateway settings**: it tests the local Ask boundary, not a mobile call. Do not copy any login, Firebase credential, cloud identity or session file into the fixture, the phone or this repository.

1. From `plugin/`, provision the helper environments once: `uv sync --project tunnel --python 3.12` and `uv sync --project media --python 3.12`. The tunnel interpreter must have the `omp_away_tunnel` package and its dependencies installed for `python -I -m omp_away_tunnel`. The media bridge always starts `media/.venv/Scripts/python.exe` (Unix: `media/.venv/bin/python`); no interpreter is selected by a request and nothing is installed during a call.
2. Set these **paths and origin only**, in the shell launching the real desktop session (PowerShell, from `plugin/`):

   ```powershell
   $env:OMP_AWAY_URL = 'https://away.example.com'
   $env:OMP_AWAY_TOKEN_FILE = Join-Path $env:LOCALAPPDATA 'omp-away\desktop.token'
   $env:OMP_AWAY_STATE_DIR = Join-Path $env:LOCALAPPDATA 'omp-away\private-state'
   $env:OMP_AWAY_TUNNEL_PYTHON = (Resolve-Path 'tunnel\.venv\Scripts\python.exe').Path
   ```

   The token file is provisioned separately by the operator: the relay's **desktop** 32-byte bearer encoded as unpadded base64url, optional final newline, readable only by the current desktop account. Never put it in a URL, prompt, shell command line, repo, clipboard or screenshot. Verify ACLs without displaying contents. State must be an absolute path to a dedicated private local directory, not source, a junction, or a shared/cloud-synced folder. Prefer a **nonexistent** final directory: the helper creates it with a noninherited current-user-only ACL (Unix: mode 0700). Sessions sharing a paired desktop must use the same state directory, origin and token. A private authenticated loopback broker owns the single relay connection; it survives an individual session closing and exits ten seconds after the last session disconnects. Do not launch a separate state directory against the same relay desktop identity. On Unix set equivalent absolute paths; use `tunnel/.venv/bin/python` and an owner-only mode 0600 token file. Without `OMP_AWAY_TUNNEL_PYTHON`, `python` on Windows or `python3` on Unix must already refer to the provisioned tunnel environment.
3. Use a **per-run** `--config` YAML overlay on the normal authenticated desktop profile. Do not replace global settings, reuse an existing nonlocal Collab room, publish a Collab port, or use a remote shell with clipboard forwarding. The three native settings are:

   ```yaml
   collab:
     relayUrl: ws://127.0.0.1:18475
     autoStart: control
   ask:
     timeout: 0
   ```

   Launch from the project with `omp --config <absolute-overlay-path> -e <absolute-plugin-directory>` (replace both placeholders). Sessions may share the configured loopback port: on a collision Away binds a free port and overrides only that process's Collab URL. The native controller retries automatically; an initial connection warning can precede recovery. Wait for **Away: local guest ready** and **Away: secure mobile gateway ready** before opening a mobile Ask. Run `/away status` to inspect routing. If mobile setup is unavailable, check paths, ACLs, HTTPS service and matching gateway configuration. When upgrading from the older single-owner helper, reload the existing desktop yourself before opening additional sessions; never start a competing production gateway or discard pairing state. Local Ask remains authoritative.
4. From an **idle local composer**, enter `/away pair`. This copies a one-time JSON payload to the system clipboard; it is never printed, entered into the composer, or emitted to the model. Disable third-party clipboard managers, syncing and capture; do not paste into a chat or online QR service. Paste into the trusted phone enrollment screen, or display a QR using a trusted **offline** renderer. Clear both clipboards and close the renderer immediately. The Windows writer opts out of clipboard history and roaming; the payload is valid for at most ten minutes. A new invitation invalidates the previous one.
5. Compare **all twelve** emoji in order on **both** devices. For an exact match, approve on the phone and enter the local widget's `/away approve CODE` on the desktop. Otherwise `/away deny CODE`. `CODE` identifies this comparison only; it is not the enrollment secret. There is no approval dialog over a native Ask. Starting work cancels a pending comparison; pair again from idle. Failure or timeout is not success. A changed phone key must not regain requests addressed to its predecessor.

### Optional Async Ask inbox

Load updated `omp-async-ask` and Away plugins in the same interactive desktop. With the gateway configured and the phone already paired, pending and restored questions appear in the existing phone inbox without opening `/questions`. Async forwarding needs no Collab configuration; the native Ask requirements above remain unchanged.

The same spoken selection, readback and separate onset-bound confirmation apply. Async Ask validates and saves the answer, then uses its ordinary user-attributed aside. Desktop answers, withdrawal and owner/session changes retire the phone offer. Agent-turn completion does not.

Shared `/away` and fallback settings apply unchanged. Restored questions keep their original creation time; a fresh owner can ring a still-pending question again. Newly paired devices do not inherit existing offers. Unsupported forms remain in `/questions`.

Saved is not delivered. After a failed or uncertain attempt, review `/questions`; there is no automatic mobile retry or resend. A closed call alone is not delivery confirmation. Each plugin remains usable without the other. Restart updated desktop plugins when work can safely pause; this integration requires no broker, relay or phone update.

### Routing and call behavior

`/away` and `/away on` enable immediate ringing for every connected session sharing this paired state directory; repeating either command leaves it enabled. `/away off` disables immediate ringing globally. `/away fallback 90` enables shared normal-mode escalation after 90 seconds from request creation; `/away fallback off` disables it. The allowed interval is 1–2,147,483 whole seconds. `/away status` fetches both shared settings from the broker. Defaults: immediate off, fallback off. Turning off immediate mode does **not** turn off a configured fallback. Ringing sends only the opaque request ID to the enrolled device route.

The broker owns `routing.json`, persists changes before broadcasting, and serializes field patches so concurrent Away/fallback commands cannot overwrite each other. Connected sessions apply snapshots to their own pending questions, and new/reconnecting sessions inherit the latest state. Already-rung or silenced questions do not ring again; active calls are not interrupted. The phone inbox combines all sessions' requests. Joining, microphone audio, captions and call controls remain bound to the request's owning session. Closing one session removes its offers and ends only its call. Pairing approval belongs only to the session that issued the invitation.

**One-time shared-routing upgrade:** update the plugin in all Away-enabled desktops, close those desktops, allow the existing broker to shut down after ten idle seconds, then reopen them. Do this only when their work can be safely paused; do not kill an active production broker to force an upgrade. Pairing and saved preferences are preserved. An older broker is detected explicitly and the new plugin refuses to pretend a local-only change is global. Legacy clients are not sent unknown routing events; they must also reload the updated plugin to participate. Routine mode changes after this upgrade need no restart. No Android or public-relay upgrade is needed.

Pair **before** starting the native Ask. A newly enrolled device does not inherit open requests. The paired inbox reconciles on connect; **Not now** suppresses ringing for that request; **Hang up** or disconnect ends the call but leaves the Ask pending. Only joining opens desktop Codex voice.

Speaker output uses the service's ordered `session.output_audio.delta` stream (24 kHz mono PCM16), normalized by the plugin-owned adapter in its pinned SDK bundle. It is never mixed with independently timed WebRTC RTP output. WebRTC still carries the microphone. Legacy `rtp.*` trace labels refer to the desktop PCM playback buffer, not proof of the audio's transport or physical presentation.

The opening is the native question; no “hello” or model-generated summary is required. PCM streams as it arrives, before the assistant's final transcript, on its 20 ms sample clock with a 100 ms handset lead. Only 100 ms of initial quiet pre-roll is retained. The queue bounds transport backpressure, not whole-response generation. Android initializes its microphone route before playback and changes to **In call** on the first AudioTrack write. Raw microphone energy does not mute the opening; recognized speech can discard queued old audio.

The Android 1.0.4 call screen shows **Speaking** while voiced output is playing and **Listening** after it drains. This is display status, not a microphone mute or submission gate. Caller and assistant captions update from the existing voice stream; provisional text is replaced by the final transcript without rebuilding call controls. Phone captions remain in memory and are cleared when the call ends; desktop transcript retention is separate and does not require caption opt-in. Update the desktop plugin/tunnel before installing this phone version: its `captions: true` join opt-in is rejected by older strict desktop validators. Updated desktops continue to accept older phones without sending captions.

New desktop narration is appended immediately, without waiting for prior assistant speech or a handset playback acknowledgment. Validated drafts have one readback owner: the realtime voice stays silent for selections, corrections and confirmations while the desktop validates them. The desktop sends the complete readback instructions and draft as silent `PREPARE_VALIDATED_READBACK` commentary chunks, followed by one bounded speakable `VALIDATED_READBACK_READY` trigger. Individual data chunks must not request speech. Interrupted preparation cannot send a stale trigger. Ordinary conversational answers still come directly from the realtime voice.

An entire, unambiguous enabled option label drafts locally through the native validator, including ASR punctuation and repeated identical labels. Mixed choices remain ambiguous. More complex proposals still need interpretation. Extraction requests SDK minimum effort on the existing host model; support is provider-dependent. No model is substituted.

Choice evidence permits spacing between the same letters of an uppercase ASCII initialism of two to eight letters, such as a recognized `JSO N` for `JSON`. This changes matching only: transcripts and evidence excerpts remain unchanged. Different letters, missing evidence, ordinary-word splitting and native labels made indistinguishable by this rule are rejected. A validated draft and separate confirmation are still required.

Ordinary conversation and contextual questions are answered directly by the realtime voice, without a forced “Okay” or a serialized desktop consultation. The desktop silently supplies a current-branch snapshot and refreshes it when the session leaf changes. Snapshots contain only bounded visible user/assistant text and the latest usable compaction summary, not tool payloads, reasoning, images or credential metadata. The serialized snapshot is capped at 24 KiB and explicitly marks missing or truncated context. Visible text is not semantic secret-redaction. Unknown progress must remain unknown; suggestions cannot change form options or submit an answer.

The opening names every enabled native choice, including the automatic Other choice when supported, grouped with its field question. Disabled options and hidden values are not spoken. Forms whose complete opening exceeds the voice budget stay on the desktop rather than silently losing choices. Task recaps are on demand, not an automatic preamble. Voice instructions, form data and task snapshots use the supported non-spoken commentary channel. The desktop remains the authority for native validation and submission.

The **Away decision timing** debug event records only the operation category, elapsed milliseconds and completion status. Separate connection setup, recognition, actual proposal extraction, first PCM delivery and handset presentation when measuring latency. There are no verification-model calls.

Closing a voice session logs an **Away voice summary** containing only elapsed time and stage counts. `voice.ready` means transport readiness, not phone playback. The legacy `rtp.replay.started` label now marks the first paced streaming write; no transcript or approval is required. A hardware presentation acknowledgment is useful test evidence but no longer authorizes submission.

The summary distinguishes recognized partial speech (`partial.user`), provider-final caller fragments (`final.user`), and local silence completions (`endpoint.user`) using counts only. Separate local transcript files retain speech as described below. **Away native bridge** logs readiness, submission start, and whether the actual native result matched the confirmed values. Neither captions nor spoken claims of submission establish native acceptance.

Ask a clarification or propose values for every editable field. A proposal is **not** a submission. Check the spoken answers and explicitly confirm in a separate utterance, for example “Yes”. Corrections replace the proposal and require a new affirmative. The desktop keeps authentication, native field validation and exactly-once submission; assistant speech and handset messages cannot submit. Answering on the desktop removes the request and closes its audio. If voice fails, complete the existing native form.

A separate clear affirmative after the current eligible readback submits its unchanged native values once. Speech that actually started before a proposal existed cannot approve a draft arriving later. If a clarification or correction has invalidated confirmation eligibility, an affirmative refreshes the existing proposal for review rather than submitting stale values. Speaker echo must not make a genuinely fresh confirmation look premature. Legacy handset `played` messages are ignored.

Away completes a caller utterance only after 1.5 seconds of stable recognition and live microphone silence: at least 75 quiet 20 ms frames, both the last voiced frame and last text update at least 1.5 seconds old, and microphone input within the last 250 ms. A stalled microphone is not silence. Provider finals replace their current partial segment and join earlier nonoverlapping fragments under the original onset; they do not immediately invoke decision handling. Duplicate finals cannot repeat words or erase a newer partial. Provider timestamps reject already-consumed speech. Malformed, overlapping, regressing or unscoped continuation data fails closed rather than retaining an affirmative prefix.

This is an intentional voice-confirmation tradeoff: “Yeah”, followed by a long pause and then “but actually no”, can submit before the qualifier. Speak a correction without that pause. The silence boundary does not remove the separate proposal/confirmation step, native validation, onset snapshot, or exactly-once submission. Ordinary realtime answers and audio do not wait for desktop decision handling.

Local microphone activity requires three consecutive 20 ms loud frames. Energy alone does not cancel work or mute playback: the onset is tentative until recognized caller speech arrives, retaining its first-frame time so delayed recognition cannot approve a newer draft. Android owns acoustic echo cancellation. The desktop forwards captured PCM unchanged, including during playback: output PCM amplitude is not comparable to handset microphone gain, and amplitude gating can erase a quieter caller's interruption. Raw capture energy still controls the silence boundary; playback cannot manufacture a completed affirmative.

Tentative noise cannot permanently own a later confirmation. Repair requires both a fresh debounced local microphone burst after the current readback was issued and recognized caller coordinates following its completed provider readback. Ordered context acknowledgments associate that completion with the prepared draft; acknowledgment timing alone is insufficient because recognition timestamps can lag physical speech. Missing or inconsistent timing keeps the original conservative onset guard. The payload-free trace records `onset.rebound`, `readback.completed` and `context.unaligned` as space-delimited counters. None of these events, assistant speech, or handset acknowledgments independently authorizes submission.

A repaired onset retains the completed-readback timestamp used to justify it. Later partials or a corrected final cannot move that caller speech before the readback or remove its timing and still authorize submission.

## Retained call transcripts

Paired calls automatically record local JSONL files in `$env:OMP_AWAY_STATE_DIR\calls` (Unix: `$OMP_AWAY_STATE_DIR/calls`). Reload the desktop plugin after updating it; already-loaded code and earlier conversations cannot acquire transcripts retroactively.

The **Away call transcript** log entry points to the current `call-<UTC timestamp>-<UUID>.active.jsonl`. On successful flush it becomes `.jsonl`, with an **Away call transcript closed** pointer. An `.active.jsonl` can also be an interrupted or failed recording; inspect it rather than assuming there was no speech.

Records include local call/request/session IDs, sequence numbers, timestamps, speaker, and:

- `delta`: recognized caller or assistant fragments, retained even without a final event or after hangup.
- `provider-final`: the provider's completed transcript, including late finals that decision handling may reject.
- `resolved-silence`: the complete aggregated caller text passed to decision handling, with onset binding. Older recordings may contain `resolved-provider` from the former immediate-final boundary.
- `event`: consultation and decision outcomes, including whether a validated draft exists, plus narration/readback appends and call ending. An `accepted` reply records native acceptance for Ask, or canonical save plus queued/recorded dispatch for Async Ask—not proof that the model read it. Speech saying “submitted” establishes neither.

Do not concatenate every speech row: finals replace their turn's deltas, and resolved rows distinguish consumed caller text from provider observations. An `ended` event can precede `decision-reply: accepted` because native completion aborts the call before the submission promise settles. Normal call teardown keeps the file open for that outcome. Missing outcomes after process shutdown or a recording failure remain unknown.

Retention runs when calls finish: keep the newest 20 completed calls, remove owned files older than seven days (including abandoned active files), and leave unrelated files alone. Each call is capped at 2 MiB and each speech event at 8192 text code units. `truncated`, `limit`, and `closed.limited` mark incomplete evidence. Disk failures warn without preventing voice or native submission.

Speech goes directly to local files, **not** centralized logger/telemetry sinks. No raw audio, authentication or pairing payloads, complete provider messages, or full coding-session prompts are recorded. Conversations themselves may contain sensitive information: keep files private, review/redact before sharing, and never attach the whole state directory. Set `OMP_AWAY_TRANSCRIPTS=0` before launching the desktop to disable new recordings; this does not delete existing files.

To inspect the newest completed call locally in PowerShell:

```powershell
$call = Get-ChildItem (Join-Path $env:OMP_AWAY_STATE_DIR 'calls') -Filter 'call-*.jsonl' |
  Where-Object Name -NotLike '*.active.jsonl' | Sort-Object Name | Select-Object -Last 1
Get-Content -LiteralPath $call.FullName | ConvertFrom-Json |
  Format-Table seq, kind, role, phase, text, stage, reply, draft -Wrap
```

## Repeatable native-live acoustic discussions

Run commands from `plugin/`. On Windows, use `python -B test/acoustic.py --list-audio`, explicitly set `ANDROID_SERIAL` to the authorized disposable-test phone, and select `--mic <input-index> --speaker <output-index>`. Run `python -B test/acoustic.py direct notes-context --mic <input-index> --speaker <output-index>` or use `--all` for both supported native-live scenarios. The runner requires `pywinpty`, `sounddevice`, `soundfile`, `numpy`, Windows speech synthesis, an authenticated host exposing native remote-live capabilities, the configured media-peer Python dependencies, and the disposable `ru.eleven.ompaway.integration` APK plus its matching test APK. Grant that disposable app microphone permission. Live host/model services may incur charges; unit tests do not use them. Never target or clear the regular app.

The runner requires explicit device and audio selections; it does not assume a workstation's hardware identities. Windows speech synthesis supplies caller lines through the selected speakers; the selected microphone measures handset playback before the next reply. Put the phone within hearing range of both. Each scenario starts a disposable host with production gateway settings removed and owns a USB reverse mapping on port 19583 without replacing an existing mapping. Artifacts stay outside the repository. It does not test the public relay.

`test/acoustic.json` contains explicitly tagged native-live discussion scenarios, not canonical-answer scenarios. Acceptance requires the exact originating question context acknowledged before native live starts or phone output begins; one takeover attempt, one accepted takeover and one originating Ask completion; no additional withdrawal and **zero** `submitConfirmed` calls; caller and assistant captions; microphone and output frames; physical playback and completed hardware/caption instrumentation. After the last fresh, audible response satisfies its configured concepts, the driver requests hangup. The live session must stop exactly once, routing must close, and a real post-call host turn must return the synthetic resumption marker. Speech claiming a submission cannot satisfy any of these conditions.

Each run prints its local `result.json` path. Bounded response observations retain configured synthetic words and bridge-audio timing relative to synthetic caller playback completion, including overlap; these are not handset presentation or network-latency measurements. Consecutive assistant fragments are grouped only within the current playback boundary and caller turn. The latest fragment must finish, physical playback must be observed, and the next reply waits for quiet. Final response concepts are required, not optional; keyword gates still do not establish semantic correctness, so inspect grounding against the supplied synthetic task facts.

The former canonical scenarios are preserved unchanged in `test/acoustic-scripted.json`. Direct `DecisionCall` tests consume their forms and exact expected values, require independent readback proof and a separate confirmation, and assert canonical submission values. Existing scripted discussion/readback/onset tests remain separate component coverage; they are not evidence that production native-live uses legacy `createCall` or `VoiceSession`, nor that all recorded acoustic dialogue steps were replayed. The native acoustic driver rejects legacy canonical scenario files rather than reporting conversation success as canonical acceptance. Legacy readback/barge-in CLI modes are not native-live acceptance modes.

Run the pure acoustic selection, scenario-validation and native acceptance regressions with `python -B test/acoustic_test.py`. This command still imports the driver's Python dependencies but does not connect to a phone or model service. A live acoustic result remains unverified until the explicit hardware command above has actually completed.

## Recording evidence

After running the gate, record host version, date, case, observed sanitized values and event counts here; note whether the operator actually saw the dialog dismiss. On a failure report the first mismatch, not an inferred winner. Do not attach full session logs, registry contents, links, tokens, raw frames or unsanitized screenshots. The test root can be discarded after the host exits and safe evidence is captured.

2026-11-23, Async Ask integration: an isolated stock 19.1.0 TUI with a scripted provider and controlled phone/voice transports completed independent work while a question remained pending. The actual `/questions` dialog opened and its handler closed after the confirmed answer. The provider observed the user-attributed answer both after agent end and during a later active work tool. No runtime errors; the owned host exited normally. This tested native inbox lifecycle and model receipt, not visual layout, acoustic recognition or a physical phone. The disposable desktop controller was removed afterward. The repeatable cross-plugin fixture separately passed ten load-order/race/restoration/failure scenarios.

2026-11-23, consultation routing fix: a live model in an isolated stock host answered the recorded “Ask the main model to come up with some other two drinks” with hot chocolate and lemonade through one consultation. “Give me two more drink ideas” reached consultation through interpretation and returned sparkling water and apple juice. Both were non-draft narration; tools stayed disabled, subsequent Yes utterances submitted nothing, and a fresh Coffee/Yes sequence completed the synthetic submission once. This probe injected bound caller transcripts and used a synthetic submission capability; it did not test recognition, handset playback, or the paired relay.

2026-11-23, transcript retention acceptance: an isolated stock 19.1.0 host and OnePlus 5T acoustic call retained 30 speech records, including both speakers, provider-completed Coffee, and a silence-completed Yes with no provider final. The JSONL file recorded `ended`, then `decision-reply: accepted`, then `closed` without truncation. There were two synthetic replies, one native Coffee submission, successful native Ask completion, and no side-model calls or runtime errors. This used the USB bridge, not the paired relay. The separate handset caption assertion failed because it requires literal “yeah” while recognition emitted “Yes”; final handset-caption verification did not pass in this run.

2026-11-23, with the silence fallback: three real acoustic/native Ask calls on the OnePlus 5T with Android 1.0.4 passed. Dock speakers supplied Coffee and Yeah; the Maono microphone measured gaps after handset speech. Each used exactly two replies, no repetition, no extraction-model calls, one accepted canonical Coffee submission, successful native Ask completion, and call closure. Phone instrumentation also checked live captions and Speaking-to-Listening transitions.

| Scenario | Coffee reply gap | Yeah reply gap | Local silence completions |
| --- | ---: | ---: | ---: |
| Normal half-second replies | 519 ms | 521 ms | 1 |
| Final-event loss injected at the desktop boundary | 503 ms | 519 ms | 2 |
| Normal one-second replies | 1019 ms | 1010 ms | 0 |

The first run observed a late provider final after local completion without losing the pending decision. In the loss-injection run, every caller-final event reaching the probe was deliberately withheld; recognition and microphone input remained real. These tests used a disposable stock host and USB media bridge, not the public paired relay. The active production desktop was not restarted.

### Earlier measurements

2026-11-23 streaming probe: the physical phone completed both opening and readback, with audio delivered before either assistant-final event. Opening to first PCM write was 4.567 s (3.190 s of voice setup); injected final answer to first readback PCM was 1.354 s. There were zero decision-model calls, zero authorization marks and zero submissions. Both hardware drains completed. This isolated stock-host test injects a final transcript and excludes recognition, production context and the paired relay path.

2026-11-23 acoustic/native acceptance on the OnePlus 5T dev phone: PC dock speakers spoke Coffee and Yeah, and the Maono microphone measured the end of handset speech. One run with 517/511 ms reply gaps and one with 1029/1007 ms gaps submitted Coffee through the real stock native Ask exactly once, observed its successful tool completion, and ended the call without repetition or extraction-model calls. The second run used Android 1.0.4 and verified live captions on the shared production call-screen renderer plus Speaking-to-Listening transitions. These used the isolated USB media bridge, not the public paired relay.

A separate 510 ms reply run before the silence fallback failed: Coffee appeared in live recognition/captions, but the provider never emitted a final caller turn. No submission occurred. A brief neutral acknowledgement alone did not reliably resolve this provider completion stall.

The measurements below predate streaming and record the removed verification-gated implementation, not current performance.

2026-11-23: the isolated stock-host physical-phone probe completed opening and independently verified readback for an injected final `Coffee` transcript: two physical drains, one readback mark, zero submissions. Opening to first approved PCM write was 7.827 s; injected final transcript to first readback PCM write was 8.670 s, including 3.656 s of independent verification. The only decision-model call was `away-verify`, with minimum effort requested. This excludes speech recognition, the production conversation and the paired relay path; it is not an end-to-end latency acceptance.

Two preceding synthetic-audio probes did not complete readback: one was interrupted by a new local microphone onset during verification; the controlled-input run received a partial input transcript but no final user turn before its deadline. No form was submitted. These failures remain separate from the passing decision/playback-only measurement.

### 2026-11-23 shared sessions and acoustic dialogues

Three independent stock `omp.exe` desktops were observed with their proxy connections attached to the same existing broker. No production desktop or broker was restarted for this check. The isolated two-desktop native Ask checks and the 23 tunnel tests also passed.

Plugin verification at this earlier stage passed 166 tests / 758 assertions and `bun check`. The six-scenario acoustic run announced Tea, Coffee and Other/custom input in every opening. Five dialogues completed exactly one accepted native submission with the expected values and passed hardware/caption instrumentation. The revision scenario stopped before its correction: the initial “Coffee” produced no caller transcript on either observed transport channel, so no answer was submitted. Earlier runs also exposed intermittent short-reply transcription loss; its cause was unresolved at this stage, and this was not a successful correction test. Qualified affirmative and stale-confirmation scenarios passed in that run.

Commentary-channel context removed the invented extra alternative suggestions in the observed follow-up calls. Readbacks were short, but occasional unscripted opening acknowledgements remained. These historical results do not establish perfect recognition, exact model narration or current direct-conversation behavior. Dev-phone display and voice-call settings were left unchanged.

### Microphone sample-clock follow-up

The media helper scheduled each microphone frame 20 ms after its actual wakeup. On this Windows host, coarse timer wakeups accumulated into a slower consumer clock, overflowing the bounded microphone queue and dropping pieces of speech before Opus encoding. The fix advances the scheduled sample deadline instead; a scheduler stall of a full frame still rebases the deadline to prevent catchup bursts. It adds no model, playback gate or confirmation exception.

A five-second synthetic sequence probe used the real media helper and 250 uniquely identifiable 20 ms input packets, without recording speech:

| Measurement | Previous pacing | Deadline-based pacing |
|---|---:|---:|
| Mean frame interval (ms) | 31.15 | 20.24 |
| Skipped packets before the last received packet | 81 | 0 |

Packets still queued at the probe deadline are not counted as skipped. All 17 media tests passed, including deterministic coarse-timer packet continuity, no catchup burst after a long stall, and actual bidirectional Opus peers. The 166 plugin tests and `bun check` also passed.

The post-fix real-phone run passed all six scenarios without retries: direct choice, options, alternatives, revision, qualified affirmative and stale confirmation. Each opening included the choices; all caller turns reached decision handling, and each dialogue completed exactly one accepted native submission with the expected values and passing hardware/caption instrumentation. At that stage the stale affirmative remained ignored, and the qualified affirmative required the corrected readback and a fresh Yes. This helper-only fix loads when the next voice call spawns its media process; it requires no phone reinstall or desktop restart. These results predate the direct-conversation changes.

2026-11-23, direct-conversation and single-readback acceptance: the eight-turn `notes-recall` scenario passed on the physical OnePlus through the USB acoustic bridge, a real authenticated voice provider and stock omp 19.1.1 native Ask. The two intentional validated readbacks each contained one Submit question; one final affirmative produced exactly one accepted native submission and native completion. Hardware/caption instrumentation passed, with no standalone holding acknowledgment or duplicate Submit prompt. Manual semantic inspection checked project, progress, missing work, constraints and rollout rationale against the synthetic task facts. Ordinary answer audio began before concurrent desktop interpretation returned. This verifies that scenario, not the remaining dialogue suite, production paired relay, or activation in existing desktop sessions.

2026-11-23, approved caller-boundary acceptance: the complete seven-turn `notes-barge-in` dialogue passed on the physical OnePlus with real microphone/speaker audio, the authenticated voice provider and stock native Ask. The caller interrupted the original JSON/Deploy readback, corrected both fields to SQLite/Keep local, discussed the rationale and offline behavior, requested another readback, then explicitly confirmed. Three intentional desktop readbacks included the interrupted original; exactly one canonical `storage=sqlite`, `rollout=keep_local` submission was accepted and the native Ask completed. Hardware and caption instrumentation passed. No duplicate Submit prompt was observed. Manual inspection checked the context answers against the synthetic task facts.

This run used the disposable USB acoustic bridge, not the paired relay or the already-loaded production desktop. Earlier attempts exposed acronym-spacing rejection and an observer that lost earlier fragments of an assistant answer; neither failed run is counted as acceptance. Regressions passed: plugin type checking, 289 plugin tests / 1336 assertions, and seven acoustic-observer tests. The remaining dialogue and paired-path checks are separate acceptance gates.

2026-11-23, additional implementation regressions: a provider delegation could stall after a holding phrase because its refusal was sent as progress-only commentary. Rejections now use the stock live controller's default final-result channel, start no work and redirect ordinary questions to the existing realtime context. Separately, an aborted classification erased the last validated draft before the caller could request its readback. Draft updates are now applied only after classification settles; stale work cannot overwrite a draft, failed completed extraction still discards it, and confirmation eligibility is revoked at onset as before. Both regressions failed before their fixes. Type checking and 292 plugin tests / 1365 assertions passed. Physical acceptance of these follow-ups remains pending.

2026-11-23, manual-semantic acceptance: the complete eight-turn `notes-recall` and eight-turn `notes-tradeoffs` conversations each finished with two intentional readbacks, no duplicate Submit prompt, one accepted canonical submission and successful hardware/caption instrumentation. Recall selected SQLite/Keep local; tradeoffs selected JSON/Keep local. Every ordinary answer was compared with the synthetic task facts, including unfinished persistence work and the absence of export/cloud sync. These runs used the explicitly reviewed profile above. The provider still added filler sounds and occasional echoed fragments; do not describe this as zero extraneous speech.

The next dialogue exposed an independent startup race: question context was sent before media setup returned, allowing initial speech while the runtime's pre-join consumers were still inactive. Initial grounding is now deferred until the owner requests narration after join delivery; it still precedes the speakable opening and later refreshes only on context changes. The regression first observed nine premature context messages. Type checking and 293 plugin tests / 1368 assertions passed. Subsequent physical calls delivered the opening after join. Longer follow-up, correction and qualification runs still exposed provider transcript omissions, competing readbacks, and merged caller discussion/selection; none of those failed runs submitted a native result. Full conversational acceptance remains open.

2026-11-23, regular-app paired path: a fresh desktop discovered the linked plugin normally, opened one built-in Ask, and reached the existing paired regular app without re-enrollment or credential copying. Physical caller speech elicited the grounded staging-retention answer, proposed both fixture values, and confirmed separately after the correct single readback and observed speaker quiet. The original native Ask returned Blue and the dictated note once; the coding model echoed the exact result, the call ended and the refreshed inbox retired that request. The owned desktop exited normally. This is functional paired-path evidence, not the legacy all-artifacts network/TLS gate.

Preservation checks matched the installed upgrade APK and original signer/UID, retained all ten backed-up files, and left pairing fields unchanged. Eight files matched the post-upgrade UI snapshot; normal runtime state updated the inbox and FCM preference. App animations remained on, screenshot blocking off, and system display settings unchanged. Remaining limitations: the provider repeated the opening after the clarification answer, structured request preview showed a summary-only fallback, the owning desktop has not reloaded, and temporary integration packages remain installed pending full acceptance.

The eight-turn hold/clarification scenario also completed with three intentional draft readbacks and one accepted JSON/Keep local result. Its ordinary answers matched the supplied project facts, and both holds prevented submission. Provider fillers and echoed fragments remained. The unknown-context run correctly withheld unavailable colleague, weather and production-metric facts, but did not reach native completion; do not count it as an accepted dialogue.

A plugin link does not retarget an independently installed editable tunnel package or reload its shared gateway. Check the configured interpreter's package mapping as well as the extension link. An older helper without structured-question/proposal support can leave an otherwise working paired call with summary-only previews. Prepare the current helper separately; activation must respect other connected desktop sessions and use an authorized graceful refresh, not a shared-process kill.
