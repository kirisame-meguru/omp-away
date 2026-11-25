# Voice pacing and full debug capture

## Approved scope

- Pace the existing desktop downlink at 20 ms per PCM frame. Preserve ordering, the existing bounded backlog, and independent microphone/control progress. Rebase after missed frames rather than sending catch-up bursts.
- Cancel pending pacing waits on call closure. Do not add retries, enlarge handset queues, discard speech during an active call, or change conversation policy.
- Extend debug diagnostics with local microphone audio, incoming audio, and partial/final transcripts, as explicitly requested after the original categorical-only diagnostics. Never record transport credentials or pairing keys.
- Keep capture initialization debug-only and artifacts in app-private no-backup storage. Retain current and previous calls; cap each audio direction at 16 MiB and each transcript file at 1 MiB. Log capture-limit and storage failures without interrupting calls. Incoming audio is not proof of playback.
- Update the signed debug app in place, preserving application identity and pairing. Load the changed desktop plugin and perform one actual Answer by voice verification.

## Implementation and verification

- [x] Reproduce unpaced burst delivery with deterministic regressions.
- [x] Implement frame-clock pacing, cancellation, and backlog-limit coverage.
- [x] Implement private per-call capture, retention, release-disabled behavior, and storage-failure tests.
- [x] Build and install the signed debug update; Android tests passed.
- [x] Complete integrated plugin checks and privacy review.
- [ ] Load the desktop fix and verify actual voice startup with saved handset evidence.
- [ ] Commit changes and report remaining release blockers; do not infer release readiness from unit tests.
