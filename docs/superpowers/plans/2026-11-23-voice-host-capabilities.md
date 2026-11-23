# Version-independent Voice Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow voice startup across host updates when the required APIs remain available.

**Architecture:** Remove the host version equality gate. Validate the session and OAuth-storage capabilities actually consumed by the bundled transport before allocating media resources; retain normal signaling and media errors. Keep build dependencies pinned, but allow any host peer version.

**Tech Stack:** TypeScript, Bun tests, existing bundled live transport and Python media helper.

**Spec:** User requirement: do not block voice by host version; host updates are frequent. Do not interrupt existing sessions.

## Global Constraints

- Work in isolation; never restart, reload, or terminate existing sessions.
- Do not alter authentication, pairing, gateway configuration, or generated SDK code.
- Keep runtime data and private deployment details out of source and commits.

---

### Task 1: Remove version gating with behavioral regression coverage

**Files:**
- Modify: `src/media/index.ts`, `package.json`, `bun.lock`
- Create: `test/voice-startup.test.ts`, `test/fixtures/voice-startup.ts`

**Interfaces:** Preserve `openVoice(options: VoiceOptions): Promise<VoiceCall>` and all audio, teardown, and authentication behavior.

- [x] Add subprocess-isolated tests running the real `openVoice` with controlled external media/signaling boundaries. Exercise host versions `19.1.0`, `19.1.1`, `20.0.0`, and `99.0.0-dev`; require startup, microphone forwarding, and teardown independent of version. Exercise missing session ID, session API, OAuth access, and rotation methods; require rejection before media setup.
- [x] Run the new regression suite and observe the version rejection.
- [x] Delete the `VERSION` import and equality branch. Check that `getSessionId` is callable before reading the session ID and obtain auth storage with `ctx.modelRegistry?.authStorage`. Require a nonempty string session ID and callable `authStorage.oauth.access` and `authStorage.limits.rotate`; otherwise throw `The current desktop session cannot authenticate Codex voice`. Start the stage message at media-helper setup.
- [x] Set only `peerDependencies["@oh-my-pi/pi-coding-agent"]` to `"*"`; retain pinned development dependencies and regenerate the lockfile.
- [x] Run all Bun tests and TypeScript checking. In a disposable current-host process, open and close voice using existing desktop authentication, without connecting the production broker or phone.
- [ ] Inspect and commit only this fix with generic author metadata. Integrate only after verifying affected shared files remain unchanged; do not reload running sessions.

Verification: 186 Bun tests passed and TypeScript checking passed. A disposable compiled omp 19.1.1 process opened the actual authenticated voice transport and media peer, then closed successfully. The probe bundled local sources to avoid standalone-extension module-resolution failures; it used no fake media or signaling. This verifies desktop startup, not handset playback or a spoken submission.
