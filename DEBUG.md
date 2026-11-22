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

Use **one** stock interactive omp 19.1.0 main session, the normal desktop Codex login, Bun 1.4.4+, a CA-trusted HTTPS gateway, and two preprovisioned Python environments. The isolated scripted fixture above deliberately has **no gateway settings**: it tests the local Ask boundary, not a mobile call. Do not copy any login, Firebase credential, cloud identity or session file into the fixture, the phone or this repository.

1. From `plugin/`, provision the helper environments once: `uv sync --project tunnel --python 3.12` and `uv sync --project media --python 3.12`. The tunnel interpreter must have the `omp_away_tunnel` package and its dependencies installed for `python -I -m omp_away_tunnel`. The media bridge always starts `media/.venv/Scripts/python.exe` (Unix: `media/.venv/bin/python`); no interpreter is selected by a request and nothing is installed during a call.
2. Set these **paths and origin only**, in the shell launching the real desktop session (PowerShell, from `plugin/`):

   ```powershell
   $env:OMP_AWAY_URL = 'https://away.example.invalid'
   $env:OMP_AWAY_TOKEN_FILE = Join-Path $env:LOCALAPPDATA 'omp-away\desktop.token'
   $env:OMP_AWAY_STATE_DIR = Join-Path $env:LOCALAPPDATA 'omp-away\private-state'
   $env:OMP_AWAY_TUNNEL_PYTHON = (Resolve-Path 'tunnel\.venv\Scripts\python.exe').Path
   ```

   The token file is provisioned separately by the operator: the relay's **desktop** 32-byte bearer encoded as unpadded base64url, optional final newline, readable only by the current desktop account. Never put it in a URL, prompt, shell command line, repo, clipboard or screenshot. Verify ACLs without displaying contents. State must be an absolute path to a dedicated private local directory, not source, a junction, or a shared/cloud-synced folder. Prefer a **nonexistent** final directory: the helper creates it with a noninherited current-user-only ACL (Unix: mode 0700). Give each desktop its own state and run only one gateway owner. On Unix set equivalent absolute paths; use `tunnel/.venv/bin/python` and an owner-only mode 0600 token file. Without `OMP_AWAY_TUNNEL_PYTHON`, `python` on Windows or `python3` on Unix must already refer to the provisioned tunnel environment.
3. Use a **per-run** `--config` YAML overlay on the normal authenticated desktop profile. Do not replace global settings, reuse an existing nonlocal Collab room, publish a Collab port, or use a remote shell with clipboard forwarding. The three native settings are:

   ```yaml
   collab:
     relayUrl: ws://127.0.0.1:18475
     autoStart: control
   ask:
     timeout: 0
   ```

   Choose a free loopback port. Launch from the project with `omp --config <absolute-overlay-path> -e <absolute-plugin-directory>` (replace both placeholders). Wait for **Away: local guest ready** and **Away: secure mobile gateway ready** before opening a mobile Ask. Run `/away status` to inspect routing. If mobile setup is unavailable, correct the paths, ACLs, HTTPS service or duplicate desktop connection; restart the session. Local Ask remains authoritative.
4. From an **idle local composer**, enter `/away pair`. This copies a one-time JSON payload to the system clipboard; it is never printed, entered into the composer, or emitted to the model. Disable third-party clipboard managers, syncing and capture; do not paste into a chat or online QR service. Paste into the trusted phone enrollment screen, or display a QR using a trusted **offline** renderer. Clear both clipboards and close the renderer immediately. The Windows writer opts out of clipboard history and roaming; the payload is valid for at most ten minutes. A new invitation invalidates the previous one.
5. Compare **all twelve** emoji in order on **both** devices. For an exact match, approve on the phone and enter the local widget's `/away approve CODE` on the desktop. Otherwise `/away deny CODE`. `CODE` identifies this comparison only; it is not the enrollment secret. There is no approval dialog over a native Ask. Starting work cancels a pending comparison; pair again from idle. Failure or timeout is not success. A changed phone key must not regain requests addressed to its predecessor.

### Routing and call behavior

`/away` toggles immediate ringing; `/away on` and `/away off` set it explicitly. `/away fallback 90` enables normal-mode escalation after 90 seconds from request creation; `/away fallback off` disables it. The allowed interval is 1–2,147,483 whole seconds. `/away status` shows both settings. Defaults: immediate off, fallback off. Preferences persist in `routing.json` in private state; neither setting expires or auto-submits a native form. Turning off immediate mode does **not** turn off a configured fallback. Ringing sends only the opaque request ID to the enrolled device route.

Pair **before** starting the native Ask. A newly enrolled device does not inherit open requests. The paired inbox reconciles on connect; **Not now** suppresses ringing for that request; **Hang up** or disconnect ends the call but leaves the Ask pending. Only joining opens desktop Codex voice.

Ask a clarification aloud or propose values for every editable field. A proposal is **not** a submission. Listen to the summary and check the values. If they are correct, agree in a **separate utterance** after playback finishes (for example, “Yes”). No challenge words or scripted response are required. If anything is wrong, say no or correct it and listen to the revised summary. The desktop checks the meaning of the summary against the current draft, not its exact wording. It accepts confirmation only after the same paired handset acknowledges physical playout for that draft. A premature yes, superseded summary, duplicate acknowledgment, or interrupted call cannot authorize submission. Answering on the desktop removes the request and closes its audio. If voice fails, complete the existing native form; do not enter answers into slash commands.

If you say “yes” too early, nothing is submitted. When a draft is still available, the call repeats its summary. Listen to the new summary and confirm separately; a delayed acknowledgment from the earlier playback does not count.

## Recording evidence

After running the gate, record host version, date, case, observed sanitized values and event counts here; note whether the operator actually saw the dialog dismiss. On a failure report the first mismatch, not an inferred winner. Do not attach full session logs, registry contents, links, tokens, raw frames or unsanitized screenshots. The test root can be discarded after the host exits and safe evidence is captured.
