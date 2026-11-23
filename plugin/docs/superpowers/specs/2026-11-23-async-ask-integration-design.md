# Away integration with Async Ask

Issue: repository issue #2.

Status: design and implementation plan approved; implemented and verified. See the implementation plan for observed checks and rollout boundaries.

## Goal and scope

Expose pending `omp-async-ask` questions through Away's existing paired-phone inbox and voice flow while the owning agent continues independent work. Async Ask remains authoritative for questions, validation, saved answers and delivery to the agent. Native `ask` keeps its current behavior.

The approved scope includes restored pending questions, shared Away/fallback settings, separate spoken confirmation, desktop/phone answer races, withdrawal and session invalidation, and honest handling of saved-but-undelivered answers. Both plugins must remain usable independently.

Changes belong in `omp-async-ask` and `omp-away/plugin`. No OMP-core, Android, public-relay, Python-broker or generated voice-SDK changes are planned. Do not restart production desktops, send commands into them, or disturb their gateway during development. Do not post issue comments or close the issue without authorization.

## Current boundaries

- Async Ask's `src/index.ts` creates a session-generation `QuestionStore` and `AnswerDelivery`. The store restores the active branch journal, validates submissions, and publishes synchronous change notifications. `AnswerDelivery` sends a user-attributed aside through the host's public API.
- Async Ask's questions survive an agent turn ending. Answered and withdrawn questions are terminal. A submitted answer can remain saved with failed or uncertain delivery; explicit resend is a separate desktop action.
- Away's native path intercepts only the built-in `ask` tool and obtains a native Collab submission capability. The separate optional adapter observes Async Ask's source, never its mutable store.
- Away's coordinator, voice confirmation, authenticated transport and shared routing already accept a request-scoped submission function. Reuse these layers rather than turning async questions into blocking native Ask calls.
- Installed OMP exposes `pi.events.on/emit` for trusted in-process extensions. Event emission is not a request/reply acknowledgement: the bridge must use an explicit callback to attach a source, with no polling or assumption that an async listener has finished when `emit` returns.

## Chosen architecture

Add an optional, versioned source bridge in Async Ask and a small source adapter in Away. The bridge exchanges in-memory capabilities only. It never serializes functions, contexts, tokens or submission authority to session history, the broker, the phone or telemetry.

Rejected alternatives:

1. Automating `/questions` through Collab depends on an open UI, competes for input, and cannot serve a background inbox reliably.
2. Reading the journal in Away and independently injecting answer messages duplicates Async Ask's validation, persistence and delivery rules and cannot establish ownership of an answer safely.
3. A new shared package, service or core API is unnecessary for two cooperating extensions. Keep the v1 structural contract small and test both actual implementations together.

### Discovery and attachment

Use two event channels:

- `omp-async-ask:available:v1`: announces only `{version: 1, sessionId}` when a supported owner becomes available. No question or capability is broadcast here.
- `omp-async-ask:connect:v1`: Away sends `{version: 1, sessionId, accept(source)}` after its mobile runtime is ready. Async Ask invokes `accept` only for its current, matching supported owner.

Register event handlers at extension initialization. Away requests a source when its runtime becomes ready and when it receives a matching availability announcement. Thus either extension/session-handler order works without sleeps or repeated probes. Repeated announcements from the same source are idempotent. Absence of either plugin is normal; it must not break native Ask or `/questions`.

A source is stable for one Async Ask owner generation and provides:

- `version: 1`, `sessionId`, and an abort signal;
- `subscribe(listener) -> unsubscribe`, delivering an initial complete pending snapshot and subsequent complete snapshots;
- immutable question offers containing canonical question ID, fresh opaque transport request ID, originating tool-call ID, title, original HTML, blocked-work description, creation timestamp, and a request-bound `submitConfirmed(values)` function.

The source does not expose its mutable store, general `sendMessage`, resend, create, withdraw, or arbitrary submission functions. Every submission closure rechecks both the captured owner identity and current session identity. Session ID alone is insufficient when navigating history within the same session.

Listener registration precedes the initial snapshot. Notifications and removal are synchronous; consumers must not rely on a later task to revoke a capability. Exceptions from bridge consumers are contained with category-only reporting, never logging their payloads or arbitrary exception text. Unsupported versions or malformed offers fail closed without disabling either plugin's normal local interface.

### Away source adapter

Maintain a separate async-offer map, not entries in the native Collab `calls` map. Async Ask creates each opaque phone request ID and owns one-shot offer retirement. Away uses that ID with a generation-specific deduplication key, preserving the original tool-call ID as metadata. Extend Away's internal offer contract with an optional deduplication key; native callers retain their existing tool-call deduplication behavior.

The adapter reconciles snapshots: add newly eligible questions, retain existing offers without reoffering, and synchronously call `admin.end` for removals. Duplicate announcements and unrelated store/delivery changes must not create duplicate phone entries or rings. Closing a source unsubscribes it and retires all of its offers before another source is attached. A new owner generation creates fresh phone capabilities even when canonical question IDs are restored.

Use the owning desktop's local context for consultation and voice, never another desktop's context. The question's HTML and blocked-work description are untrusted contextual data, not instructions or authorization. Any added prompt wording belongs in static templates.

Initialize the mobile runtime independently of native Collab configuration. Missing or failed Collab support disables only native Ask forwarding; it must not prevent direct async forwarding when gateway settings and an Async Ask source are available. Preserve existing native configuration validation and explicit diagnostics. Do not weaken a native submission gate to make async forwarding work.

## Routing, persistence and lifetime

- Both sources use the existing coordinator and broker-owned Away/fallback settings. Neither plugin gains another routing file or preference writer.
- Async offers preserve their original `createdAt`. Extend the internal offer contract with an optional creation timestamp; native offers retain their current clock default. At the bridge boundary, require a nonnegative safe integer representing Unix milliseconds. Fallback age is measured from question creation, not subscription or reopening `/questions`; retain ordinary clock behavior if a clock adjustment puts creation in the future.
- In immediate mode, a pending eligible async question can ring without opening `/questions`. In normal mode, the existing fallback timer applies. Disabling immediate mode preserves fallback and does not terminate an active call.
- Async offers survive `agent_end`, completion of the `ask_async` tool call, and closing the desktop inbox. Native cleanup at those boundaries remains native-only.
- Desktop submission, withdrawal, session clear, branch/tree navigation, owner disposal and shutdown retire affected async offers and invalidate old confirmations. Handle same-session history navigation as an owner-generation change, not merely a session-ID comparison.
- A cancelled navigation can leave the same session active and cause Async Ask to recreate its owner later. Fresh generation keys must permit legitimate reattachment without reviving an old submission closure.
- A corrupt/unrestorable Async Ask journal exposes no phone capabilities. Existing local diagnostics remain available.
- Repeated snapshots in one live generation preserve rung/silenced state. As with existing Away behavior, a fresh process/runtime generation may ring a still-pending question again. This work does not add a durable notification ledger or promise suppression across desktop restarts.

### Pairing and approval boundaries

Retain Away's authenticated-device checks and capture the authorized audience when an offer enters the current runtime. A newly paired device does not acquire an already-offered question; device connection or enrollment must not cause a blanket reoffer of old questions. Restoring a session creates fresh capabilities for devices already paired when that restored runtime offers them. Do not persist device credentials or audience capabilities in Async Ask's journal.

Unsupported forms stay in `/questions` with no phone submission capability. Reuse Away's current native-form parser and speech evidence rules, including choice validation, hidden-value handling and explicit confirmation. Spoken form answers carry no fabricated option notes; notes remain an optional desktop capability in v1.

Async submission never dispatches a native Collab reply or resolves a native tool approval. Unrelated approvals retain their local controls. Answering an async question while an approval is pending may queue the ordinary aside, but cannot authorize that approval or execute its tool. Native Ask's existing approval guards remain unchanged.

## Submission and delivery semantics

The phone uses Away's existing draft/readback flow. Only a separate, onset-bound affirmative can invoke the question's submission closure. Silence, preselection, consultation, stale speech and repeated confirmations remain non-authorizing.

Both desktop and phone submission must use one canonical Async Ask submission path. Extend `AnswerDelivery` with an explicit receipt/outcome that captures the answer ID created by that invocation and its dispatch outcome. Preserve the current desktop error/recovery behavior. Do not infer that a phone won by finding an arbitrary matching answer afterward, and do not duplicate `QuestionStore` validation in Away.

The source maps that canonical result into these bridge outcomes:

| Outcome | Meaning | Away behavior |
|---|---|---|
| `accepted` with answer ID and `queued` or `recorded` delivery | This invocation saved the validated answer; dispatch returned or a matching receipt was observed | Retire the offer; do not claim the model read or acted on it |
| `saved` with answer ID and current delivery state | This invocation saved an answer but dispatch failed, remained incomplete, or became uncertain | Retire the offer, surface a local delivery warning, and leave recovery in `/questions`; never retry automatically |
| `stale` | Owner changed, question ceased to be pending, or another submission won | No write or dispatch; retire the obsolete offer |
| `invalid` | Canonical validation rejected values before saving | No write or dispatch; retire this phone offer and leave the canonical question pending for local completion |

Only the captured invocation's receipt may produce `accepted` or `saved`. If an exception leaves persistence uncertain, do not manufacture an answer ID or success. Async Ask removes attempted offers from its source snapshot, including rejected/uncertain attempts that leave the canonical question pending. Away retires its transport offer, reports uncertainty locally and requires journal reconciliation/local review rather than retrying from the phone. An unrelated snapshot cannot automatically recreate an attempted offer.

The transition from pending to answered occurs before store observers run. A desktop/phone race therefore permits only the winner to create an answer in the live store; the loser sees a terminal question. Retire the phone offer synchronously on that transition, including during the phone's own submission. Retiring the call must not abort the already-started canonical dispatch or erase its captured result. Conversely, an observer that switches sessions must prevent dispatch into the successor session.

Do not revive an answered question because delivery failed or lacked a receipt. Do not attach a resend capability to the phone. Keep Async Ask's explicit desktop resend flow and warnings about possible duplicate delivery.

The current phone protocol ends calls without a delivery-receipt screen. Call termination is not a claim of successful agent delivery. Keep detailed delivery state in `/questions` and use a local warning for saved-but-failed/uncertain dispatch; do not inject success narration, send a late unscoped phone error into a successor call, or require an Android update. This integration does not promise crash-proof exactly-once persistence/delivery; it preserves one attempt per live voice confirmation and canonical terminal-state ownership.

## Files and ownership

### omp-async-ask

- Add `src/bridge.ts`: v1 discovery, immutable source snapshots, owner-scoped submission capabilities and disposal.
- Update `src/index.ts`: publish/connect the current owner, wire source invalidation and expose the existing lifecycle safely.
- Update `src/delivery.ts`: canonical receipt/outcome shared by desktop and bridge; keep normal aside delivery and explicit resend semantics.
- Keep `src/state.ts` authoritative; modify it only if a demonstrated invariant requires a central change rather than duplicating state elsewhere.
- Add contract tests and update the existing README's optional Away integration guidance.

### omp-away/plugin

- Add `src/runtime/async-ask.ts`: optional source discovery/attachment, snapshot reconciliation and request-scoped forwarding.
- Update `src/index.ts`: separate native and async lifecycle handling; decouple mobile startup from Collab readiness; cover tree/clear lifecycle transitions.
- Update the internal offer/coordinator types and `src/decisions/index.ts` for original creation time and source-generation deduplication while preserving native defaults.
- Update `src/runtime/routing.ts` only where necessary for source outcomes and local diagnostics. Reuse existing voice, transport, global routing and pairing mechanisms.
- Add cross-plugin acceptance coverage and update `DEBUG.md` and decision integration documentation.

Neither installed plugin imports the other at runtime or requires a sibling checkout. Keep matching v1 structural contracts local and verify their interoperability with the real plugins. A cross-repository acceptance harness accepts explicit checkout locations; ordinary package tests and installation remain independent.

## Verification and acceptance

Every test defends an observable contract, not source text or static wiring:

1. Either plugin alone still works; either load/start order discovers pending questions without opening `/questions` or polling.
2. A real `ask_async create` returns immediately; the phone offer survives agent-turn end while independent work continues.
3. New and restored pending questions appear once; answered/withdrawn records do not. Fallback uses original question age. Duplicate source announcements do not re-ring.
4. Global enable/off and fallback updates apply to both question sources across independent desktop runtimes without altering active call authority.
5. Spoken selection plus a separate confirmation produces one canonical stored answer and one ordinary aside attempt in the originating session. Defaults, stale onset, repeated confirmation and forged request IDs do not submit.
6. Race both desktop-first and phone-first answers. The loser cannot overwrite, dispatch again or mutate the successor question, even when values match.
7. Withdrawal, clear, tree/branch navigation, cancelled navigation followed by owner recreation, and shutdown revoke old capabilities and close affected calls without losing legitimate fresh offers.
8. Store observers that retire the call during submission do not prevent valid same-session dispatch; observers that replace the owning session do prevent successor-session delivery.
9. Exercise validation rejection, persistence failure/ambiguity, synchronous dispatch failure, queued delivery without a receipt, matching receipt, and restored saved answers. No automatic resends or false delivery acknowledgement.
10. Missing native Collab configuration does not disable async forwarding. Native Ask guards and actual tool approvals remain intact.
11. Newly enrolled devices cannot acquire existing offers; malformed bridge messages, wrong sessions, unsupported forms and corrupt histories never gain submission authority.
12. Run both package suites/type checks and Away's relevant tunnel regressions after integration. Use an isolated stock desktop with both actual plugins to prove the native inbox, background agent behavior and answer delivery together. Do not operate production sessions for acceptance.

Any phone acceptance uses only the previously authorized development phone and retains its settings/data. This integration changes request ownership and dispatch, not audio pacing; do not repeat an unrelated acoustic sweep. Verify the actual async phone-answer path if hardware acceptance is needed, without weakening confirmation or leaving delivery uncertainty unreported.

## Rollout and review boundary

Commit changes separately in their owning repositories after verification; do not push without authorization. Users reload/restart the two updated desktop plugins when their work can pause. The already-upgraded shared-routing broker and phone do not need replacement for this design.

Implementation and verification are recorded in the approved plan. Production desktops were not restarted; activation remains a user-controlled reload when work can pause.
