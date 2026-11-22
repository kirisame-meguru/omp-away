# Capturing the actual confirmation gate

The native Ask callback cannot show whether a matched handset playout receipt preceded it. Collect the **executed** desktop decision transitions independently during the positive case. Never infer them from source, the final values, or a speech transcript.

Use an unused **loopback-only** Bun Inspector port on a private, access-controlled desktop. A debugger grants control of the paid session; if the machine or debugger is not trusted, stop. Never forward or publish the URL or open it in a hosted web debugger. Keep the same cwd, existing authenticated config, private child overlay, and model as in [the runbook](../DEBUG.md). Resolve `$cli` to stock omp 19.1.0's installed package `bin.omp` entry (`dist/cli.js`, not the development tree). Use `bun --inspect=127.0.0.1:<owned-port> $cli --config $overlay --no-session --no-extensions -e $extension -e $observer --tools ask --model $codexModel` **instead of** a second host. Do not copy credentials or create a new profile. Use a trusted local WebKit/Bun debugger; [Bun debugger options](https://bun.com/docs/runtime/debugger). Keep verbose fetch/HTTP diagnostics disabled.

Set **non-pausing** conditional logpoints on the real `plugin/src/runtime/routing.ts` path below before the first Ask. Bind to actual executable positions/source maps, not assumed line numbers. Observe the following locals only. Don't expand `call`, transcripts, reply text, challenge words, headers, SDP, device ID, keys or access credentials. Never evaluate a decision method or alter a variable. A representative logpoint expression (evaluate in the indicated scope; substitute its literal event and two listed local expressions) is:

```js
JSON.stringify({event:EVENT, at:Date.now(),
  request:new Bun.CryptoHasher('sha256').update(REQUEST_ID).digest('hex'),
  mark:new Bun.CryptoHasher('sha256').update(MARK_ID).digest('hex')})
```

| Event literal | Executed site / condition | `REQUEST_ID` | `MARK_ID` |
|---|---|---|---|
| `"readback"` | `onTranscript` reply continuation when dispatching `sendSpeakable`; only `reply.kind === 'say' && typeof reply.mark === 'string'` | `id` | `reply.mark` |
| `"provisional"` | `onProvisional`, assignment to `call.provisional` **after** the current-call and actual acoustic confirmation guards succeed | `id` | `mark` |
| `"mark"` | `onMark`, dispatch of the matching `sendControl` mark **after** the outstanding-mark guard | `id` | `mark` |
| `"played"` | `onMessage` / `case 'played'`, dispatch of `call.decision.played(...)` **after** same device/request/outstanding-mark checks | `message.requestId` | `message.mark` |

Copy **all** such JSON records, one per line and in observed order, to `decision.ndjson` in this run's private evidence directory. Do not select only matching rows from a multi-attempt run. Zero or multiple readbacks, a missing mark, a duplicate receipt, a broken tracepoint or a pause that changes the media behavior makes this attempt inconclusive/failed. Don't manufacture rows or emit test events to see a branch. The offline verifier joins the actual marks, request fingerprint, time of spoken affirmative and native execution end. This is externally observed evidence, not a production logging hook or permission to add one.

For desktop live-model evidence, observe the built `session.model` on the **actual sent payload** via the return from `buildLiveSessionPayload` (model-only inspection) and the accepted `#signalWithAccess` branch paired with this join. A success code on another request is not proof. Record only the model, status and times; keep the separate paid ledger entries for the coding-model brief/clarification/extraction. If these dynamic observation points aren't available in the installed build, do not fill expected values by hand.
