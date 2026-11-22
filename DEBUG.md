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

Trusted in-process extension code may listen on `pi.events.on("omp-away:pending-ask", ...)`. Its `PendingAsk` has original `html`, `requestId`, `toolCallId` and `submitConfirmed(requestId, values)`. Only publish to a real device through a separately authenticated, confirmation-aware integration; do not serialize the function or expose this as an agent tool. There is no arbitrary frame, shell, UI control, or network submission endpoint. Unrelated dialogs and approvals are ineligible. An old capability cannot affect a later Ask. `accepted` requires dispatch of the confirmed guest steps **and** an exact match to this call's native result; the host protocol does not distinguish two sides submitting identical data. This gate uses distinguishable values and deliberate ordering for that reason.

## Recording evidence

After running the gate, record host version, date, case, observed sanitized values and event counts here; note whether the operator actually saw the dialog dismiss. On a failure report the first mismatch, not an inferred winner. Do not attach full session logs, registry contents, links, tokens, raw frames or unsanitized screenshots. The test root can be discarded after the host exits and safe evidence is captured.
