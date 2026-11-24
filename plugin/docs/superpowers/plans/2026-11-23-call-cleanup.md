# Call Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent successful voice submissions from producing false invitation and teardown errors; push and install the fix without disturbing active sessions.

**Architecture:** Treat inbound data sent before the handset learned of call completion as a retired-call tail. Drop only that tail, never forward it to any coding session, and use the next ordered join as the boundary that restores strict pre-join validation. Treat invitation fan-out as successful when at least one paired device accepts an invitation, and retain errors when all attempts fail.

**Tech Stack:** TypeScript/Bun, Python asyncio, authenticated TLS/WebSocket tunnel, existing broker integration tests.

**Spec:** User-requested correction of invitation warnings and a reproduced post-submission microphone-frame race, using an isolated worktree followed by private publication and installation.

## Global Constraints

- No changes to existing active-session worktrees, pairing records, credentials, or live broker processes.
- Reject microphone frames before the first joined call and while a new call is only joining.
- Keep malformed framing, unknown controls, wrong request IDs, and unauthorized playback marks fatal.
- Remember at most the most recently retired call and its existing bounded outstanding marks; clear that state at the next join.
- Do not claim FCM acceptance proves delivery, or imply a completed desktop form is still available.
- No live call reproduction is needed: the successful submission and failure were already observed.

---

### Task 1: Protocol teardown

**Files:** `tunnel/omp_away_tunnel/service.py`, `tunnel/tests/test_phone.py`, `tunnel/tests/test_broker.py`.

**Interface:** `Phone.incoming(msg)` returns whether a validated message should be forwarded. `Phone.incoming_pcm()` validates state and returns whether a well-framed PCM packet belongs to the active call.

- [x] Add regression coverage for joined -> ended -> trailing PCM/hangup/known playback acknowledgment, followed by a new call on the same authenticated tunnel. Require no error or lost event, no old PCM forwarding, and correct new-owner routing.
- [x] Cover idle/pre-join PCM, unknown/malformed tail controls, wrong request IDs, and stale acknowledgments after the next join; these must still fail.
- [x] Add a single retired-request ID and draining flag. Preserve bounded marks until the next join. Return false only for validated retired-call traffic; the service must not forward it to the broker.

### Task 2: Invitation and UI reporting

**Files:** `src/runtime/routing.ts`, `src/decisions/index.ts`, `src/runtime/index.ts`, `test/runtime.test.ts`, `test/invitations.test.ts`.

- [x] Add partial-success, all-failure, synchronous-failure, and delayed-failure-after-join tests at the actual runtime/coordinator boundary.
- [x] Replace all-or-nothing fan-out with `Promise.any` over individually wrapped ring attempts. Preserve the existing audience authorization and never retry invitations automatically.
- [x] Suppress deferred invitation failures once the request is silenced, joined, submitted, or ended.
- [x] Remove the unconditional desktop-form-available suffix. Give total push failure and actual protocol failure accurate, fixed messages; do not hide genuine errors.

### Task 3: Verify and deliver

- [x] Run the complete Bun suite, TypeScript check, and Python tunnel suite, including the real TLS/broker regression.
- [ ] Review the diff and security boundaries inline. Commit only these changes using generic metadata.
- [ ] Apply the component patch to a separate worktree at the current private remote main, verify matching Git blobs, and push a normal fast-forward update. No mirror synchronization or history rewriting.
- [ ] Fast-forward the unchanged installed component checkout and verify the installed link matches the pushed code. Do not restart the shared broker or reload protected sessions; distinguish installation from activation.

Verification: 192 Bun tests and 35 Python tunnel tests passed; TypeScript checking passed. The new TLS/broker test sends late PCM and controls before the phone observes the desktop end, then opens a second session's call on the same authenticated connection. It verifies no old media/control/error reaches either session, and that only the new owner receives the new audio. This is local protocol integration evidence, not a new production handset call or FCM delivery test.
