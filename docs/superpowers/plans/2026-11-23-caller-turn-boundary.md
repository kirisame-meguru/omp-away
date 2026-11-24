# Caller Turn Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve complete caller turns and reuse an independently verified spoken readback without duplicate requests or weakening native submission safeguards.

**Architecture:** Keep realtime audio and conversational answers independent. Buffer bounded, chronologically scoped recognition and provider-final segments under the original caller onset; finish only after 75 live quiet 20 ms microphone frames and 1.5 seconds of stable recognition and microphone silence. Coordinate caller-derived canonical drafts with complete assistant-response observations, independent field verification and the handset's existing strict playback acknowledgment; confirmation snapshots cannot acquire later evidence.

**Tech Stack:** TypeScript, pinned native live SDK, Bun tests, existing Python acoustic harness, Android communication audio.

**Spec:** User-approved silence boundary and readback reuse; `docs/superpowers/specs/2026-11-22-omp-away-design.md`, especially “Approved readback coordination”; existing acoustic requirements in `plugin/DEBUG.md`.

## Global Constraints

- No microphone muting, transcript-word removal, hidden captions, model substitution, or additional serialized conversational-answer model.
- Preserve native validation, immutable drafts, onset eligibility, stale-request protection, separate explicit confirmation and exactly-once submission.
- Keep the existing 1500 ms silence threshold, 75 quiet frames, 250 ms microphone freshness bound and 8192-character recognition bound.
- Malformed, overlapping or unscoped timing must fail closed rather than retain an affirmative prefix.
- Preserve the original physical onset across buffered provider segments.
- Operate only on the authorized OnePlus. Keep private recordings, transcripts, endpoints and device identifiers outside the repository.
- Finish this upgrade before starting issue #6; finish and verify the #6 release before starting issue #7.

---

### Task 1: Buffer complete caller utterances

**Files:** Modify `plugin/src/media/session.ts`; test `plugin/test/voice.test.ts` and `plugin/test/runtime.test.ts`.

**Interfaces:** Keep `VoiceSession.input(pcm)`, `event(event)` and `VoiceCallbacks` unchanged. `onSpeechStarted` continues to identify the original recognized onset. `onTranscript('user', text, id)` becomes the single completed-utterance boundary for both partial recognition and provider-final segments.

- [x] Add and run a failing public-interface regression using `endpointHarness()`:

```ts
const h = endpointHarness();
try {
  h.advance(3, speech);
  await h.partial('Wait stop.', 100, 200);
  await h.complete('Wait stop.', 100, 200);
  expect(h.transcripts).toEqual([]);
  h.advance(10, speech);
  await h.partial('I meant SQLite and Keep local.', 300, 600);
  await h.complete('I meant SQLite and Keep local.', 300, 600);
  expect(h.transcripts).toEqual([]);
  h.advance(75);
  expect(h.transcripts).toEqual([
    ['user', 'Wait stop. I meant SQLite and Keep local.', h.starts[0]],
  ]);
} finally { h.close(); }
```

- [x] Add equivalent cases for a finalized Yes followed by a qualifier, duplicate finals, corrected whole-utterance finals, malformed/overlapping ranges, stalled capture and hangup. Assert no intermediate native submission and no discarded qualifier.
- [x] Retain a finalized prefix separately from the current partial segment. On a scoped provider final, replace that segment with its final transcript and preserve prior nonoverlapping segments. Enforce the existing total text bound before retaining the new aggregate.
- [x] Route provider finals through the same stable-recognition/live-silence endpoint instead of immediately calling `#finishCaller`. Advance `#resolvedThrough` only when the aggregate is consumed. Clear every pending segment on finish, interruption invalidation or stop.
- [x] Update deterministic voice/runtime fixtures to supply the actual quiet-frame boundary; do not add production bypasses for tests or weaken early-confirmation assertions.
- [x] Run `bun run check` and `bun test test`; inspect every failure and preserve the existing malformed timing, stale onset and exactly-once cases.

Verified implementation boundary: type checking passed; 277 plugin tests, 1267 assertions, no failures. Regressions first demonstrated retained affirmative prefixes after ambiguous timing and native submission after a corrected final contradicted stale-onset repair; both now fail closed. This is not physical or paired-path acceptance.

Follow-up implementation verification: type checking and 292 plugin tests / 1365 assertions passed after two additional regressions. Rejected provider delegations now use the stock final-result channel rather than progress-only commentary. Interrupted classification preserves the last validated draft without preserving confirmation eligibility; failed completed extraction still discards it. The delegation-channel regression and both interrupted-classification variants failed before their fixes. Real conversation acceptance remains separate.

### Task 2: Physical acceptance and delivery

**Files:** Update `plugin/DEBUG.md` and `plugin/src/decisions/API.md` with verified behavior and limitations. Keep captured evidence outside the repository.

- [x] Run the existing `notes-barge-in` acoustic scenario on the authorized device. Require the correction to reach native handling intact, no old-draft submission, one Submit question per validated readback, one final affirmative and exactly one accepted native result.
- [x] Verify literal Yes and No each draft their native option first, then submit exactly once after a separate confirmation.
- [x] Complete recall and tradeoff dialogues with manual semantic review of every ordinary answer, unchanged readback/native gates, exactly one accepted result and passing hardware/caption checks.
- [x] Complete the hold/clarification dialogue with both holds respected, grounded answers, three intentional draft readbacks and one final accepted result.
- [ ] Complete follow-up, correction, qualification and unknown-context scenarios. Inspect actual responses against synthetic task facts, not only keyword gates. A private review profile may omit ordinary-answer keyword gates only when all such answers receive explicit semantic review; opening, readback and canonical submission gates remain unchanged. Honor explicit provider cooldowns without changing models.
- [x] Verify regular-app preservation and a fresh desktop's supported plugin discovery through an actual paired native submission, with separate physical speech, exact native values, model continuation and refreshed-inbox retirement.
- [x] Activate the owning desktop through native restart and verify its restored session, plugin target, and native Away status reporting the secure gateway and local guest ready.
- [ ] Verify the final voice implementation in the owning desktop after any further source changes. Do not restart other desktop sessions for debugging.
- [ ] Resolve the structured-preview fallback using an independent debugging helper; keep shared helpers and the regular app's pairing untouched. Remove temporary test packages only after complete acceptance.
- [ ] Review the current diff and privacy findings, rerun relevant integrated checks, and commit only owned files with generic contributor author/committer metadata. No publication, mirror triggering or history rewriting as part of this upgrade.

### Approved follow-up direction

The user explicitly approved independently checking an already-spoken readback and avoiding a second request when it matches the current caller-derived validated draft. This supersedes the earlier uncertain desktop-only selection. An incomplete, incorrect, interrupted or stale readback cannot authorize confirmation; assistant speech must never supply missing caller choices. Preserve completed playback, a separate later caller confirmation, the approved live-microphone silence boundary and exactly-once native submission.

Debugging must use an independent helper instance with separate private state, identity, listeners and relay control connection. Do not connect a second helper to the production relay control endpoint or restart other sessions. A local TLS relay fixture may support debugging, but its readiness is not evidence of physical-phone or production-paired acceptance.

### Task 3: Bind confirmation to independent readback and playback proof

**Files:** Modify `plugin/src/decisions/call.ts`, `plugin/src/decisions/side.ts`, `plugin/src/decisions/API.md`; create `plugin/prompts/decisions/verify.md` and `plugin/test/readback.test.ts`; update positive-path fixtures in `plugin/test/decisions.test.ts`.

**Interfaces:** Keep the caller-derived `DecisionReply` draft payload. Add these methods to `DecisionCall`:

```ts
readback(utteranceId: string, mark: string, transcript: string): Promise<boolean>;
played(mark: string): void;
outputStarted(): void;
```

`readback` binds an observation to the current proposal owner, starts a separate tool-free verification and never changes canonical values. `played` records a single current proof's receipt time. `outputStarted` revokes uncaptured eligibility without rewriting an already captured caller-onset snapshot. Retain at most the current proof and a proof captured by the active caller utterance; abort superseded verification work.

- [ ] Add and run the following regression before changing production behavior. Use real `prepare` and `createCall`, not a submission stub that accepts arbitrary values:

```ts
import { expect, test } from "bun:test";
import { createCall } from "../src/decisions/call";
import { prepare } from "../src/decisions/form";

test("draft issuance without readback/playback proof cannot authorize Yes", async () => {
  const form = prepare('<form><label for="drink">Drink</label><select id="drink" name="drink"><option value="tea">Tea</option><option value="coffee">Coffee</option></select></form>')!;
  const writes: unknown[] = [];
  const call = createCall({
    form, history: [], close() {},
    ctx: { async runEphemeralTurn() { throw Error("Literal choice needs no extraction"); } },
    async submit(values) { writes.push(values); return "accepted"; },
  });
  try {
    await call.brief();
    call.speechStarted("selection");
    expect((await call.speechFinished("selection", "Coffee")).kind).toBe("say");
    call.speechStarted("confirmation");
    await call.speechFinished("confirmation", "Yes");
    expect(writes).toEqual([]);
  } finally { call.close(); }
});
```

Run `bun test test/readback.test.ts`; the initial failure must be an actual native submission without proof, not a missing import or API.

- [ ] Add a `verify` side purpose returning the existing full `{fields:[{name,value,evidence}]}` extraction schema, or an unverifiable result. Its input is `{transcript}`, with native form metadata but no previous draft or expected answer hints. Require one final Submit question, every editable field, literal evidence, no contradictory/conditional choice and no submission claim. Feed successful results through `extractDraft(form, transcript, result)` without a previous draft; compare the resulting canonical values to the captured proposal with `isDeepStrictEqual`.
- [ ] Remove confirmation eligibility from `read(draft)`. Record its caller-turn owner. On onset capture only the current immutable proposal and an observation already received and acknowledged as played before `startedAt`. A pending verification may finish for that captured evidence; check the current work token, request, proposal identity and utterance before submitting. Do not attach later marks, transcripts or draft updates to the snapshot.
- [ ] Add explicit positive and negative tests using the new methods: matching proof and one later Yes; unknown/replayed mark; late mark after onset; mismatched/omitted/negated fields; duplicate Submit; verifier failure; qualifier/correction/cancellation while verification is pending; newer onset before verification completes; literal Yes/No options. Positive legacy tests must explicitly supply valid readback and playback evidence, not receive an automatic production bypass.
- [ ] Run `bun test test/readback.test.ts test/decisions.test.ts` and inspect every changed confirmation expectation. Keep hidden native values local and unchanged.

### Task 4: Observe complete current responses without gating audio or captions

**Files:** Modify `plugin/src/media/protocol.ts`, `plugin/src/media/session.ts`, `plugin/src/media/index.ts`; test `plugin/test/media-protocol.test.ts`, `plugin/test/voice.test.ts` and `plugin/test/voice-startup.test.ts`.

**Interfaces:** Export a bounded immutable `SpokenResponse` containing `id`, `utteranceId`, `text`, `startMs` and `endMs`. Add:

```ts
// VoiceCall and its VoiceSession implementation:
response(utteranceId: string, waitForStart?: boolean): Promise<SpokenResponse | undefined>;
played(responseId: string): void;
// VoiceCallbacks:
onOutputStarted?(): void;
```

`response` returns the complete current response, waits for one already in progress, or returns undefined when none exists. `waitForStart=true` is used only after requesting a fresh readback; use the existing bounded first-audio deadline and abort lifecycle. A new requested readback clears only obsolete observation state, never captions or captured speech.

- [ ] Extend protocol regressions to expect validated output-audio coordinates, then preserve `start_ms`/`end_ms` on parsed audio events. Keep existing PCM size, duration and ordering validation.
- [ ] Add a regression that waits for a fragmented current response and proves it cannot resolve before all matching audio is delivered. Use actual frame pacing and deferred `onAudio` promises. Include late finals from older caller turns, overlapping/regressing ranges, interrupted output, transcript-before-audio, audio-before-final, missing coordinates and stalled output.
- [ ] Bind observations to the caller owner when output begins, not when its final happens to arrive. Retain only bounded current response text (8192 characters), provider ranges and a current waiter. Combine scoped final fragments without deleting raw captions. Require final transcript coverage, ordered audio coverage and completion of queued writes before returning evidence. Do not resolve from the middle of an audio packet while later frames in that packet remain unqueued.
- [ ] Invoke `onOutputStarted` for new assistant speech. Preserve the existing microphone forwarding and 1500 ms endpoint implementation. `played(responseId)` may strengthen stale-noise onset repair only for the corresponding completed response, with the same fresh local-burst and provider-range guards; it is not semantic verification or submission permission.
- [ ] Run `bun test test/media-protocol.test.ts test/voice.test.ts test/voice-startup.test.ts`. Confirm unchanged caller PCM, visible partial/final captions, bounded backpressure and startup grounding.

### Task 5: Coordinate reuse, correction and physical playback in runtime

**Files:** Modify `plugin/src/runtime/routing.ts`, `plugin/prompts/voice.md` and the delegation rejection wording in `plugin/src/media/session.ts`; test `plugin/test/runtime.test.ts`.

**Interfaces:** Consume Task 3's `DecisionCall` proof methods and Task 4's response methods. Use existing `DesktopControl` `{type:"mark",requestId,mark}` and paired `{type:"played",requestId,mark}` messages; do not introduce another wire protocol.

- [ ] Add a runtime regression where a current spontaneous response says the complete correct draft and Submit once. After canonical extraction, verify zero additional `sendSpeakable` readback requests, one mark sent after audio delivery, no native submission from the mark itself, and one result only after a separate later caller confirmation.
- [ ] For a draft reply, await the current response before requesting speech. Register `decision.readback(owner, response.id, response.text)` before sending its mark so a fast acknowledgment cannot be lost. Await verification; if it matches, do not request another readback. If it does not match and the runtime revision is still current, request one corrected readback and observe/verify it with the same pipeline. Missing or stalled completion fails closed, not by issuing overlapping requests.
- [ ] Route `played` only for the current device/request and pending response ID. Call both decision and media proof handlers; consume the pending ID once. Invalidate pending current review on caller onset, interruption, replacement or close, while preserving only the already captured immutable confirmation snapshot. Maintain existing operation accounting and log cleanup around asynchronous verification.
- [ ] Update prompts so the provider may read caller choices once without promising a second desktop answer. Desktop validation remains authoritative; a correction request is not a reason to repeat both the old and new draft. Keep direct ordinary answers, no automatic recap and all captions.
- [ ] Test wrong values, missing values, a readback already in progress, duplicate Submit, rejected verification, early/late/stale/duplicate marks, qualified Yes, corrections while verification runs, interrupted readbacks, desktop winning, and exactly-once submission. Run `bun test test/runtime.test.ts`, then `bun run check` and `bun test test` at the integrated boundary.

### Task 6: Exercise the coordinated path through the independent helper and phone

**Files:** Update `plugin/test/fixtures/acoustic.ts`, `plugin/test/acoustic.py`, `plugin/test/acoustic_test.py` and existing debug documentation only as needed. Keep runtime launchers, credentials, device selection and captured data outside Git.

- [x] Start a separate current-source `Service`/`Broker` instance with a loopback TLS relay fixture and owner-only state. Verify the production TypeScript launcher connects, receives routing state and sees an empty independent pairing registry. Verify the shared gateway process and metadata remain unchanged. This does not connect the phone or prove FCM.
- [ ] Connect the acoustic fixture to the isolated real helper instead of its mock gateway, retaining the existing physical OnePlus audio path. Carry response IDs and actual handset playback marks end to end; a scripted acknowledgment or a transcript final cannot substitute for AudioTrack completion.
- [ ] Extend observation tests so readback reuse is classified from the real coordinator result and its causal response ID. Preserve duplicate-Submit detection, all raw observations, interruption gates, native result identity and exactly-once checks; do not simply relabel an earlier ordinary response as accepted.
- [ ] Complete the outstanding follow-up, correction, qualified-Yes and unknown-context physical scenarios, then the affected interruption regression. Inspect ordinary answers semantically. Exercise real delegation rejection if emitted; do not claim that branch from unrelated successful calls.
- [ ] Verify final paired regular-app behavior and structured previews without disturbing unrelated desktop sessions. Recheck signer, UID, pairing, settings and data; remove only the two temporary integration packages after acceptance. Review privacy and owned diffs, then commit the completed stage-one changes with generic contributor identities. No pushes or mirror synchronization.
