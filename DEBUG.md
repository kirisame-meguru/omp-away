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
   $env:OMP_AWAY_URL = 'https://away.example.invalid'
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

New desktop narration is appended immediately, even if a previous provider response has not finished. There are no semantic speech/readback checks, assistant-final barriers, quiet-tail waits before appending, or handset-acknowledgment authorization gates. Provider speech is unchecked; only a caller's separate explicit confirmation can submit canonical native values.

An entire, unambiguous enabled option label drafts locally through the native validator, including ASR punctuation and repeated identical labels. Mixed choices remain ambiguous. More complex proposals still need interpretation, and contextual questions still consult the owning coding session. Extraction requests SDK minimum effort on the existing host model; support is provider-dependent. No model is substituted and the context byte limit does not trim history.

Informational requests also include commands such as “Ask the main model for two other drinks” and “Please suggest alternatives.” These use the existing tool-free consultation, not a form selection or a new verification model. Less direct phrasing can reach consultation through the existing interpretation step. Suggestions do not change the form's options, create a draft, or authorize an earlier draft; the caller must explicitly choose and separately confirm.

The opening names every enabled native choice, including the automatic Other choice when supported, grouped with its field question. Disabled options and hidden values are not spoken. Forms whose complete opening exceeds the voice budget stay on the desktop rather than silently losing choices. Voice instructions and form context also travel over the supported non-spoken commentary channel; the coding session remains the authority for consultation and native submission.

The **Away decision timing** debug event records only the operation category, elapsed milliseconds and completion status. Separate connection setup, recognition, actual proposal extraction, first PCM delivery and handset presentation when measuring latency. There are no verification-model calls.

Closing a voice session logs an **Away voice summary** containing only elapsed time and stage counts. `voice.ready` means transport readiness, not phone playback. The legacy `rtp.replay.started` label now marks the first paced streaming write; no transcript or approval is required. A hardware presentation acknowledgment is useful test evidence but no longer authorizes submission.

The summary distinguishes recognized partial speech (`partial.user`), provider-completed caller turns (`final.user`), and local silence completions (`endpoint.user`) using counts only. Separate local transcript files retain speech as described below. **Away native bridge** logs readiness, submission start, and whether the actual native result matched the confirmed values. Neither captions nor spoken claims of submission establish native acceptance.

Ask a clarification or propose values for every editable field. A proposal is **not** a submission. Check the spoken answers and explicitly confirm in a separate utterance, for example “Yes”. Corrections replace the proposal and require a new affirmative. The desktop keeps authentication, native field validation and exactly-once submission; assistant speech and handset messages cannot submit. Answering on the desktop removes the request and closes its audio. If voice fails, complete the existing native form.

A yes that started before any proposal existed cannot approve a draft arriving later. Once the proposal exists, there is no verification or playback-acknowledgment wait. Legacy handset `played` messages are ignored.

If the provider does not finish a caller turn, Away uses a 1.5-second silence fallback: recognized text must remain unchanged, the microphone must deliver at least 75 quiet 20 ms frames, and both the last voiced frame and last text update must be at least 1.5 seconds old. A stalled microphone is not silence. A provider final arriving first still wins. Provider audio timestamps prevent late finals from consuming already handled speech or applying an old affirmative to a newer proposal. Malformed or unscoped continuation data disables the fallback rather than retaining an affirmative prefix.

This is an intentional voice-confirmation tradeoff: “Yeah”, followed by a long pause and then “but actually no”, can submit before the qualifier. Speak a correction without that pause. The fallback does not remove the separate proposal/confirmation step, native validation, onset snapshot, or exactly-once submission.

Local microphone onset requires three consecutive 20 ms loud frames, rather than treating a single acoustic spike as a new caller turn. The onset retains the first frame's time: a draft published during this debounce cannot become eligible for that utterance's confirmation. Provider-confirmed speech and cancellation remain active, and audio playback is still streamed without an authorization gate.

## Retained call transcripts

Paired calls automatically record local JSONL files in `$env:OMP_AWAY_STATE_DIR\calls` (Unix: `$OMP_AWAY_STATE_DIR/calls`). Reload the desktop plugin after updating it; already-loaded code and earlier conversations cannot acquire transcripts retroactively.

The **Away call transcript** log entry points to the current `call-<UTC timestamp>-<UUID>.active.jsonl`. On successful flush it becomes `.jsonl`, with an **Away call transcript closed** pointer. An `.active.jsonl` can also be an interrupted or failed recording; inspect it rather than assuming there was no speech.

Records include local call/request/session IDs, sequence numbers, timestamps, speaker, and:

- `delta`: recognized caller or assistant fragments, retained even without a final event or after hangup.
- `provider-final`: the provider's completed transcript, including late finals that decision handling may reject.
- `resolved-provider` / `resolved-silence`: caller text actually passed to decision handling, with onset binding.
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

## Repeatable acoustic dialogues

On this Windows test workstation, `python test/acoustic.py direct` runs one short native Ask dialogue; `python test/acoustic.py --all` runs all scenarios in `test/acoustic.json`. Individual names can also be supplied. The runner needs `pywinpty`, `sounddevice`, `soundfile` and `numpy`, the existing authenticated stock host, and the built Android test APK installed with `adb -s e497de61 install -r <test-apk>`. Never use `connectedDebugAndroidTest`, uninstall, or clear storage.

The runner is deliberately restricted to dev phone `e497de61`, Maono Elf input 21 and Thunderbolt Dock output 16. Windows speech synthesis supplies the caller's lines through the speakers; the microphone measures handset playback before the next reply. Each scenario starts a disposable host with production gateway settings removed and connects the phone through USB reverse port 19583. It does not test the public relay.

Scenarios cover a direct choice, asking for options, asking for two alternatives, revising a draft, an affirmative with an immediate qualifier, and saying Yes after a clarification invalidated the old draft. The caller does not answer the opening until captions name Tea, Coffee and Other/custom input and handset speech is heard and quiet. Success requires the expected native values, exactly one accepted submission, native Ask completion and passing hardware/caption instrumentation. The runner never treats an assistant's claim of submission as success.

Each run prints its local `result.json` path. Retained call JSONL files are under the scenario's `voice.log.state/calls`; inspect final/resolved speech there for brevity, grounding and recognition failures. Logs stay local. No model verifies another model's answer, no response buffering or playback-authorization gate is introduced, and no test result changes native confirmation rules.

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

Plugin verification passed 166 tests / 758 assertions and `bun check`. The six-scenario acoustic run (`away-dialogues-_d9jjp8q` under the local temp directory) announced Tea, Coffee and Other/custom input in every opening. Five dialogues completed exactly one accepted native submission with the expected values and passed hardware/caption instrumentation. The revision scenario stopped before its correction: the initial “Coffee” produced no caller transcript on either observed transport channel, so no answer was submitted. Earlier runs also exposed intermittent short-reply transcription loss; its cause was unresolved at this stage, and this was not a successful correction test. Qualified affirmative and stale-confirmation scenarios passed in that run.

Commentary-channel context removed the invented extra alternative suggestions in the observed follow-up calls. Readbacks were short, but occasional unscripted opening acknowledgements remained. These results do not establish perfect recognition or exact model narration. Dev-phone display settings remained `15` / `3600000`, and voice-call volume remained `4`.

### Microphone sample-clock follow-up

The media helper scheduled each microphone frame 20 ms after its actual wakeup. On this Windows host, coarse timer wakeups accumulated into a slower consumer clock, overflowing the bounded microphone queue and dropping pieces of speech before Opus encoding. The fix advances the scheduled sample deadline instead; a scheduler stall of a full frame still rebases the deadline to prevent catchup bursts. It adds no model, playback gate or confirmation exception.

A five-second synthetic sequence probe used the real media helper and 250 uniquely identifiable 20 ms input packets, without recording speech:

| Measurement | Previous pacing | Deadline-based pacing |
|---|---:|---:|
| Mean frame interval (ms) | 31.15 | 20.24 |
| Skipped packets before the last received packet | 81 | 0 |

Packets still queued at the probe deadline are not counted as skipped. All 17 media tests passed, including deterministic coarse-timer packet continuity, no catchup burst after a long stall, and actual bidirectional Opus peers. The 166 plugin tests and `bun check` also passed.

The post-fix real-phone run (`away-dialogues-gd3j5edo` under the local temp directory) passed all six scenarios without retries: direct choice, options, alternatives, revision, qualified affirmative and stale confirmation. Each opening included the choices; all caller turns reached decision handling, and each dialogue completed exactly one accepted native submission with the expected values and passing hardware/caption instrumentation. The stale affirmative remained ignored, and the qualified affirmative required the corrected readback and a fresh Yes. This helper-only fix is loaded when the next voice call spawns its media process; it requires no phone reinstall or desktop restart.
