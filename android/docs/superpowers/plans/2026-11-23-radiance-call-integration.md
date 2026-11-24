# Radiance Call Integration Implementation Plan

> **For agentic workers:** Use the approved task ownership and interfaces below. Do not re-delegate. Main session owns architecture, audio correctness, integration, acceptance and the final commit. Workers skip builds, lint, tests and formatters mid-flight; the main session runs the integrated checks.

**Goal:** Integrate the approved Radiance shell and waves into the actual omp-away call UI, driven by real microphone and presented playback levels instead of a synthetic envelope.

**Architecture:** Extract the existing renderer into one Android library consumed by both apps. Production keeps its existing activity-owned call, capture, playback, permissions and secure window. A lightweight call screen samples a bounded audio-level timeline; amplitude changes use the existing wave equations and shell states.

**Tech Stack:** Kotlin, Android Views, Filament 1.56.0, Android API 29+, JDK 17, compile SDK 36, Build Tools 36.0.0.

**Spec:** User-authorized integration of the approved prototype into omp-away, with real Listen/Speak reactivity and unchanged wave appearance. This plan records the implementation contract, not a new demo feature.

## Constraints

- Preserve the wave shader, colors, compiled material and shell-motion behavior.
- Keep synthetic timing only in the separately installable Study app.
- No new recorder, audio session, microphone permission, transport message or audio recording storage.
- Sample capture PCM already read by CallService. Sample output PCM by playback frame position, not socket arrival.
- No audio-thread UI work, per-frame object allocation or unbounded sample history.
- Preserve audio routing, strict playout acknowledgements, captions, hangup, foreground-only audio and FLAG_SECURE.
- Respect system reduced motion; use an explicit local animation override only if provided by the call UI.
- Keep production inbox and pairing workflows intact. Render/caption refreshes must not recreate the native engine.
- Do not commit private configuration, device identifiers, captures, transcripts or test audio. No remote publication is part of this change.

## Task 1: Shared renderer (worker-owned)

Files: new `radiance/` library; renderer classes/material/assets/tests moved from `prototype/`; root `build.gradle.kts`, `settings.gradle.kts`; `prototype/build.gradle.kts`, prototype Activity, choreography, material compilation script and existing prototype plan as needed. Do not edit `app/`.

Public package: `com.example.radiance`.

```kotlin
interface EnergySource {
    fun energy(seconds: Float, mode: Int): Float
}
// Public classes, otherwise retaining existing APIs:
// ShellMotion
// OrbSurface(context, report, slow, shell, energySource)
// OrbFallback(context, shell, energySource)
```

- [x] Move (do not fork) ShellMotion, OrbSurface, OrbFallback, QualityPolicy, material source/asset and relevant tests into `radiance`.
- [x] Inject EnergySource into the two renderer constructors. Replace only their Choreography.energy calls with the interface call. No shader or wave math changes.
- [x] Keep Choreography and its tests in prototype; implement EnergySource there. Update imports and constructor calls.
- [x] Keep material compilation pinned to Filament 1.56.0 and point its source/output at the library.
- [x] Keep renderer lifecycle and automatic fallback behavior intact. Worker returned changes without committing.

## Task 2: Actual audio levels (main-owned)

Files: `app/src/main/java/ru/eleven/ompaway/AudioVisualLevels.kt`, `CallService.kt`, `Gateway.kt`, and unit tests.

- [x] Write tests covering little-endian PCM RMS, silence/noise gating, monotonic amplitude, output not-yet-presented frames, silence/gaps, bounded history and closure.
- [x] Calculate normalized RMS from existing 20 ms PCM buffers, using a wide accumulator and no copies.
- [x] Store playback level intervals in fixed primitive arrays with frame start/end positions. Read them against AudioTrack playbackHeadPosition for display only; keep strict timestamp-based acknowledgements unchanged.
- [x] Give each CallService its own meter. Invalidation clears levels, and retired calls cannot animate a new call.
- [x] Expose one stable call-level source to the foreground UI. No microphone use before existing explicit join/permission handling.

## Task 3: Production call screen (main-owned)

Files: `app/build.gradle.kts`, `CallScreen.kt`, `InboxActivity.kt`, `Gateway.kt`, pure presentation model/tests and Android instrumentation tests.

- [x] Add the shared renderer dependency and create the renderer only for an actual call.
- [x] Use a persistent call screen rather than recreating the engine when captions/status change.
- [x] Drive shell state from joining, audible assistant playback, listening and ended states. Smooth amplitude with fast attack and slower release; quiet audio returns to rest.
- [x] Preserve live user/assistant captions, speaker toggle and Hang up. Use actual labels and captions, never fictional prototype text. Captions scroll independently so long text cannot hide call controls.
- [x] Stop callbacks on pause, release resources on destruction, and close audio through the existing Gateway lifecycle. Hide the shell on end without delaying audio shutdown.
- [x] Preserve FLAG_SECURE. Do not weaken capture protection to obtain screenshots.

## Task 4: Integrated acceptance (main-owned)

- [x] Run unit tests for app, shared renderer and prototype; build/lint all affected modules with JDK 17.
- [x] Verify approved shader and material bytes remain unchanged after extraction; verify prototype remains separately buildable with its existing separate application ID.
- [x] Instrument actual AudioRecord/AudioTrack paths with a non-private deterministic fixture: real capture, output-level tracking, end/reset and UI state changes.
- [x] Cover reduced motion and rapid state changes in unit tests; retain measured fallback policy and rendering implementation unchanged. Hardware tests cover call-screen retention, pause/resume, speaker routing and hangup cleanup.
- [x] Use isolated fixtures rather than a deployed desktop session. No deployment, pairing migration or backend-provider conversation is claimed.
- [x] Inspect the integrated diff and audit owned files; commit the verified integration with generic contributor metadata.

## Verification and install isolation

`-PisolatedIntegration=true` builds `ru.eleven.ompaway.integration`, labeled **omp-away Integration**. It skips production push registration and the Google Services configuration task. The normal build retains the original application ID, label and push configuration. This flag does not modify signing material or installed release data.

The hardware test uses real AudioRecord/AudioTrack and the actual CallScreen. A separate test injects a test-only session into Gateway to verify the production InboxActivity's call-screen retention and Hang up path without opening a paired inbox. Tests do not save PCM or transcripts. This verifies audio-to-visual integration, not a deployed speech-provider round trip.
