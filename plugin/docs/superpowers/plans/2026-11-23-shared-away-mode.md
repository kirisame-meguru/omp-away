# Shared Away Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/away` enables immediate Away routing across every connected desktop using the same paired state directory.

**Architecture:** The existing authenticated local broker owns and persists routing preferences. Desktops subscribe to ordered snapshots, send field patches rather than stale complete objects, and reconfigure their existing session-local decision coordinators. Native Ask ownership and active calls remain local.

**Tech Stack:** TypeScript/Bun, Python asyncio, the existing framed local broker protocol and private atomic JSON storage.

**Spec:** User-approved design in this conversation: bare `/away` and `/away on` are idempotent global enable; `/away off` disables immediate routing globally; new/reconnecting sessions inherit state; no duplicate ringing or interruption of active calls; no Android or public-relay changes.

## Global Constraints

- Work only in the Away plugin; keep the oh-my-pi checkout read-only.
- Preserve pairing data, native validation, onset snapshots, separate confirmation and exactly-once submission.
- Never restart or type into production desktops, kill the production broker, or start a competing production gateway.
- Scope shared preferences to authenticated clients of the same existing broker/state directory.
- Preserve `delayMs` when changing `away`, and preserve `away` when changing fallback.
- Persist before broadcasting; reject invalid patches and failed writes without changing live state.
- Older clients must not receive unknown events. New shared-routing clients must report an explicit upgrade requirement against an older broker rather than silently changing only themselves.
- Keep transcripts and credentials out of telemetry and verification output.
- Verify isolated multi-session behavior and commit completed changes.

---

## Task 1: Broker-owned routing state

**Files:**
- Modify `tunnel/omp_away_tunnel/broker.py`: persistence, serialized routing commands, opt-in broadcasts, ready capability.
- Create `tunnel/omp_away_tunnel/preferences.py`: strict routing schema and private file load/save, reusing identity helpers.
- Modify `tunnel/tests/test_broker.py`: real authenticated clients, concurrent patches, persistence, rejection and legacy isolation.

**Interfaces:**
- Command: `{op: 'routing', id: number, patch?: {away?: boolean, delayMs?: number | null}}`.
- Snapshot event: `{event: 'routing', preferences: {away: boolean, delayMs: number | null}}`.
- Successful reply carries the same complete preferences as `value`; snapshot precedes reply.
- Ready events advertise `routingVersion: 1`.
- A successful `routing` command subscribes that client. Unchanged requests still return the requesting client's snapshot, without redundant broadcasts to other clients.
- `load_preferences(directory: Path) -> dict`, `patch_preferences(current: dict, patch: object) -> dict`, `save_preferences(directory: Path, preferences: dict) -> None`.

- [x] Add failing socket-level tests. Subscribe two clients, change `away` from the first, and assert the second receives the enabled snapshot; repeat enable and check a subsequent devices reply has no duplicate snapshot ahead of it. Send independent `away` and `delayMs` patches concurrently and assert both survive. A newly attached client must receive the latest state. A non-subscribing legacy client must still receive its ordinary devices reply without an unknown event.

```python
send_frame(first.writer, 1, encode({'op': 'routing', 'id': 1, 'patch': {'away': True}}))
self.assertEqual((await first.expect('routing'))['preferences'], {'away': True, 'delayMs': None})
self.assertTrue((await first.expect('reply'))['ok'])
self.assertEqual((await second.expect('routing'))['preferences'], {'away': True, 'delayMs': None})
```

- [x] Run the focused new tests with the tunnel virtualenv and observe the unsupported-command failure before implementation.
- [x] Implement strict validation: only `away` and `delayMs`; `away` is exactly bool; `delayMs` is null or an integer from 0 through 2147483647, excluding bool. Read existing `routing.json` once under the broker ownership lock; only a missing file gets defaults. Use `read_private_json` and `write_private_json`, not another filesystem implementation.
- [x] Serialize changes under an asyncio lock. Persist off the event-loop thread before publishing, draining an in-flight write on cancellation before releasing broker ownership. Check that a queued client remains attached before applying its command. Broadcast only to subscribed clients and acknowledge after the snapshot.

```python
async with self.routing_lock:
    if client not in self.clients:
        return
    next_preferences = patch_preferences(self.preferences, cmd.get('patch', {}))
    changed = next_preferences != self.preferences
    if changed:
        await asyncio.to_thread(save_preferences, self.directory, next_preferences)
        self.preferences = next_preferences
    client.routing = True
    for recipient in tuple(self.clients):
        if recipient.routing and (changed or recipient is client):
            recipient.event(event='routing', preferences=self.preferences)
    client.event(event='reply', id=cmd['id'], ok=True, value=self.preferences)
```

- [x] Test malformed patches, persistence failure and persisted restart loading without disabling a valid mode or publishing an uncommitted state. Keep existing call/media isolation tests passing and account for the extra ready capability in exact wire assertions.

## Task 2: Desktop subscription and global commands

**Files:**
- Modify `src/decisions/preferences.ts` and `src/decisions/index.ts`: retain shape validation, add patch validation, remove obsolete per-desktop persistence writers.
- Modify `src/secure-channel/index.ts`: `onRouting`, `routing(patch?)`, capability check and validated snapshot dispatch before startup completes.
- Modify `src/runtime/routing.ts`: apply ordered snapshots through `core.configure`, forward snapshots to admin, expose async patch configuration.
- Modify `src/runtime/index.ts`: no direct preference file I/O; bare command means enable; status uses broker snapshots; commands send only the changed field.
- Modify `src/index.ts`: actionable startup guidance for an older broker.
- Modify `test/runtime.test.ts`, `test/decisions.test.ts` and `test/fixtures/acoustic.ts` for the changed API and regression coverage. Add `test/fixtures/shared-routing.ts`, driven by broker tests, for real TypeScript/Python integration.
- Update `DEBUG.md` and `src/decisions/API.md` with shared semantics and the one-time migration.

**Interfaces:**
- `SecureDesktopOptions.onRouting?(next: Preferences): void`.
- `SecureDesktop.routing(patch?: Partial<Preferences>): Promise<Preferences>`.
- `MobileRuntime.configure(patch: Partial<Preferences>): Promise<void>`.
- `Settings` accepts `onRouting` and the runtime applies a snapshot before forwarding it to admin.
- Remove the obsolete per-desktop initial-preferences argument from `connectRuntime`; the broker snapshot is authoritative before startup completes.
- `preferencePatch(data: unknown): Partial<Preferences>` validates outbound field patches.

- [x] Add failing behavior tests for repeated bare `/away`, remote updates reflected by status, pending asks ringing once across session runtimes, active-call continuity, and new-session inheritance. Test no stale response overwrites a later snapshot and no file is written by admin.
- [x] Implement secure subscription: ready must advertise `routingVersion === 1` when shared routing is requested; otherwise reject with `shared-routing-upgrade-required`. Validate routing events before invoking callbacks. Startup must observe a snapshot before resolving.
- [x] Forward snapshots synchronously to the coordinator and admin. Commands await the broker but never apply reply values over newer events. Preserve local offer/submit authority and close-generation guards.

```typescript
const patch: Partial<Preferences> = fallback
    ? {delayMs: fallback[1] === 'off' ? null : Number(fallback[1]) * 1000}
    : {away: args !== 'off'};
await runtime.configure(patch);
```

- [x] Verify with `bun test test`, `bun check`, tunnel unittest discovery, and disposable admin/runtime instances exercising the actual TypeScript gateway protocol through separate Python proxies. No phone audio test is required for a routing-only change; do not touch the personal phone.
- [x] Document that all existing desktops need the new plugin, and the old broker needs one user-controlled restart (close its clients, allow idle shutdown, reopen). Never perform that migration without the user's action. Routine `/away` changes after migration require no restart.
- [x] Review the final diff, record verification evidence, remove temporary probes, and commit the implementation and this plan together after the integrated checks pass.

## Verification evidence — 2026-11-23

- `bun test test`: 167 passed, 767 assertions, zero failures.
- `bun check`: passed.
- Tunnel virtualenv `python -m unittest discover -s tests`, with Bun on PATH: 29 passed, no skips.
- Actual admin/runtime/secure-channel code, three independent Python proxies and one disposable authenticated broker verified global enable/off, repeated enable, preserved fallback, new-session inheritance and survival after the originating runtime closes.
- Real gateway startup rejected an older broker and malformed snapshots without replacing the broker or disrupting its existing client. Corrupt persisted routing cannot publish a default-off broker.
- Runtime tests verified pending requests ring once and an active call retains only its owning session's submission authority after a global mode change.
- `git diff --check`: passed. No Android, public-relay, generated SDK or production process changes.
- Integration uses minimal UI contexts, not fresh stock TUI processes. Production activation remains pending the user's one-time close/wait/reopen migration.
