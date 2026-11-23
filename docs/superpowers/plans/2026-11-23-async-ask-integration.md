# Async Ask Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer pending Async Ask questions through Away without blocking the owning agent or replacing canonical validation/delivery.

**Architecture:** Async Ask publishes an optional versioned in-process question source. Away reconciles that source into its existing paired-phone coordinator, retaining source-generation authority and the existing voice confirmation gate. Async Ask alone persists answers and dispatches ordinary user asides.

**Tech Stack:** TypeScript, Bun, OMP public extension/event APIs and native HTML form validation.

**Spec:** `docs/superpowers/specs/2026-11-23-async-ask-integration-design.md` (approved; the user also pre-approved this implementation plan).

## Global Constraints

- Work only in the Async Ask checkout and Away's `plugin/` checkout; keep OMP core read-only.
- No Android, public-relay, Python-broker or generated voice-SDK changes are planned.
- Both plugins must remain usable independently; no runtime dependency on the other package or sibling checkout.
- No automatic resubmission, no forged native tool results, no model/default/silence authorization.
- Preserve native Ask and tool-approval gates, paired-device authorization and onset-bound separate confirmation.
- No production restarts, gateway replacement, injected desktop commands or personal-phone use.
- Keep credentials, transcripts, question contents and contexts out of diagnostic logs.
- Commit verified work separately in each owning repository; do not push or post issue comments.
- Implementation stays inline because receipt handling and synchronous lifecycle revocation cross both interfaces. Execute focused red tests before implementation, then batch integrated checks at the final boundary.

---

## Task 1: Canonical submission receipts and Async Ask source

**Files (Async Ask repository):** modify `src/delivery.ts`, `src/state.ts`, `src/index.ts`, `test/extension.test.ts` and `README.md`; create `src/bridge.ts` and `test/bridge.test.ts`. Receipt regressions live at the bridge contract rather than duplicating delivery tests.

**Interfaces:**

```typescript
interface SubmissionReceipt {
  answerId: string;
  delivery: DeliveryState;
  failure?: { error: unknown };
}
// AnswerDelivery: desktop submit delegates and rethrows receipt.failure.error when present.
submitWithReceipt(id: string, data: HtmlFormData, notes: AnswerNote[]): SubmissionReceipt;

// Wire contract is structural and in-process, not serialized.
type QuestionSubmission =
  | { kind: 'accepted' | 'saved'; answerId: string; delivery: DeliveryState }
  | { kind: 'stale' | 'invalid' | 'uncertain' };
interface AsyncQuestion {
  id: string; requestId: string; toolCallId: string; title: string; html: string;
  blockedWork: string; createdAt: number;
  submitConfirmed(values: HtmlFormData): QuestionSubmission;
}
interface QuestionSource {
  version: 1; sessionId: string; signal: AbortSignal;
  subscribe(listener: (questions: readonly AsyncQuestion[]) => void): () => void;
}
interface OwnedQuestionSource extends QuestionSource { close(): void }
createQuestionSource(store: QuestionStore, delivery: AnswerDelivery, current: () => boolean): OwnedQuestionSource;
```

- [x] Add receipt regressions proving the returned answer ID belongs to this invocation, matching receipts survive synchronous send exceptions, and owner replacement after saving cannot dispatch into its successor. Reuse existing journal, receipt and input fixtures:

```typescript
const f = setup();
const q = f.store.create(input, 'receipt');
const receipt = f.delivery.submitWithReceipt(q.id, {target: 'staging'}, []);
expect(receipt.answerId).toBe(f.store.get(q.id)!.answer!.id);
expect(receipt.delivery).toBe('queued');
expect(f.sent).toHaveLength(1);
expect(() => f.delivery.submit(q.id, {target: 'production'}, [])).toThrow();
expect(f.sent).toHaveLength(1);
```

- [x] Verify focused receipt/source contracts and the final package suite. No separate pre-implementation red result is claimed here.
- [x] Implement one canonical submission path: assert owner, call `store.submit`, capture its answer ID, invoke existing `#send`, then return that answer's delivery observation. Capture dispatch failures, not persistence/validation errors; preserve desktop recovery behavior.
- [x] Export `InvalidAnswerError` for canonical validation failures without duplicating validation. Map it to `invalid`; other pre-receipt exceptions remain `uncertain`.
- [x] Implement immutable cached offers and complete synchronous snapshots. Async Ask owns fresh request IDs and removes attempted offers even when canonical state remains pending. Submission closures check owner/store/question identity. Only recorded delivery or queued dispatch without a failure is accepted.
- [x] Implement versioned availability/connect channels with a callback scoped to the current owner. Publish after owner assignment and dispose synchronously on invalidation. Use a real event bus in extension tests.
- [x] Cover pending snapshots without UI, disposal, corrupt history, withdrawal, races, invalid values, persistence uncertainty and saved send failure without automatic retry.

## Task 2: Away adapter and independent mobile startup

**Files (Away plugin):** create `src/runtime/async-ask.ts` and `test/async-ask.test.ts`; modify `src/index.ts` and relevant native-extension test fixtures.

**Interfaces:** locally declare the v1 structural source contract above using Away's existing primitive form value type. Use only `on`/`emit` from `ExtensionAPI['events']`.

```typescript
interface AsyncAskConnection { close(): void }
connectAsyncQuestions(
  events: Pick<ExtensionAPI['events'], 'on' | 'emit'>,
  sessionId: string,
  admin: Pick<Admin, 'offer' | 'end'>,
  ctx: ExtensionContext,
  report: (code: string) => void,
): AsyncAskConnection;
```

- [x] Verify adapter discovery, stable request IDs, removal and stale retained capabilities with an in-memory bus and capture admin.
- [x] Register availability before connect; require version 1, matching session, live signal and callable subscription. Repeated same-source acceptance is a no-op.
- [x] Use Async Ask's fresh request ID with an async-specific deduplication key. Validate bounded fields and timestamps; preserve original metadata and existing voice-form eligibility checks.
- [x] Reconcile snapshots and retire removals synchronously. The provider owns attempted-offer removal; Away also retains inactive records until removal/disposal. Report static local warnings, never unscoped late phone errors.
- [x] Detach old subscriptions and abort listeners before successors; protect synchronous subscription re-entry and disposal.
- [x] Start mobile independently of Collab, attach only to the current generation, preserve native guards and separate native agent-end cleanup from async lifetime. Handle tree/clear and owner invalidation.
- [x] Verify standalone Async Ask, native regression coverage and async forwarding without native Collab.

## Task 3: Coordinator timing and confirmation integration

**Files (Away plugin):** modify `src/index.ts`, `src/decisions/index.ts`, `src/decisions/form.ts` and `test/decisions.test.ts`; exercise the existing runtime through the cross-plugin fixture.

```typescript
// Optional additions preserve every native caller's current defaults.
interface PendingAsk {
  requestId: string; toolCallId: string; html: string;
  deduplicationKey?: string;
  createdAt?: number;
  submitConfirmed(requestId: string, values: Values): Promise<Delivery>;
  context?: { title: string; blockedWork: string };
}
// Coordinator:
const key = ask.deduplicationKey ?? ask.toolCallId;
const createdAt = ask.createdAt ?? this.#clock.now();
```

- [x] Observe red regressions for restored age and generation deduplication, then verify the fixes: 25-second-old questions retain only 5 seconds of a 30-second delay; new source generations can restore the original tool ID without reviving old requests.
- [x] Preserve native defaults, shared configuration and once-per-generation ringing; reject invalid creation timestamps.
- [x] Exercise actual selection/readback/separate-confirmation with one canonical answer/aside attempt and duplicate rejection. Synchronous source retirement preserves the submitting invocation's receipt.
- [x] Verify desktop victory, withdrawal and invalidation reject retained phone authority; existing native confirmation/approval tests remain passing.

## Task 4: Cross-plugin acceptance and documentation

**Files:** add an explicit optional cross-checkout integration fixture under Away `test/fixtures/`; update Away `DEBUG.md`, `src/decisions/API.md`, Async Ask `README.md`, and this plan's evidence section.

- [x] Run both actual plugins in both registration orders using an optional static-import fixture and a temporary tsconfig alias, without installed sibling dependencies.
- [x] Cover actual tool creation, agent-end survival, voice confirmation, answer-ID matching, desktop-first answers, withdrawal, restoration and synchronous send failure.
- [x] Exercise an isolated stock desktop: independent work completed with a pending question; the real inbox handler closed after confirmation; the scripted provider received the user-attributed answer both while idle and during independent work. No production sessions were operated.
- [x] Document setup, restored age, independent use, unchanged routing, unsupported forms and saved-vs-delivered recovery without exactly-once claims.
- [x] Run integrated checks:

```powershell
# Async Ask: use Bun 1.4.4+ from PATH or Away's existing local Bun installation.
bun test ./test
bun run check
# Away plugin:
bun test test
bun check
# Tunnel, through its configured virtualenv with Bun available to integration tests:
python -m unittest discover -s tests
# Each owning repository:
git diff --check
```

- [x] Review scoped changes and preserve production boundaries. Commit each repository separately after verification; do not push. Activation remains a user-controlled desktop restart.

## Execution evidence

Observed on 2026-11-23 with Bun 1.4.4:

- Async Ask: 57 tests, 277 assertions, zero failures; type check passed (15 files).
- Away: 176 tests, 817 assertions, zero failures; `bun check` passed.
- Tunnel: 29 tests passed.
- Cross-plugin fixture: all ten scenarios passed across both registration orders.
- Stock OMP 19.1.0: `mode: tui`, `hasUI: true`; two independent work tools completed and two submitted answers reached the scripted provider. The real inbox opened and its handler closed once; zero runtime errors; owned process exited 0.
- Stock acceptance used controlled voice/phone transports. It did not inspect visual layout or test acoustic recognition, hardware or the public relay. Its temporary desktop controller was removed rather than retained as another harness.
- The first provider-observation check incorrectly filtered out user-attributed developer-role asides. Correcting that test filter established receipt without changing production delivery.

The repeatable cross-plugin fixture is `test/fixtures/async-integration.mjs`. Give Bun a temporary `--tsconfig-override` file whose `compilerOptions.paths["async-ask-under-test"]` points to the explicit Async Ask checkout's `src/index.ts` (with an absolute `baseUrl`). Run the fixture from the Away plugin checkout. It uses controlled transports, not production gateway settings or credentials.
