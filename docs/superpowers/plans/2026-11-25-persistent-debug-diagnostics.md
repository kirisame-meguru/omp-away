# Persistent Debug Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist actionable, privacy-safe phone diagnostics in dev/debug builds without changing call behavior.

**Architecture:** A debug-only journal writes categorical lifecycle/failure events to two bounded app-private files. Gateway, foreground service, audio engine, and transport report existing transitions and failure branches; production release builds do not retain these logs.

**Tech Stack:** Kotlin, Android, JUnit, Gradle.

**Spec:** Approved diagnostic update and persistent dev/debug logging requirement. Retain shutdown causes across app restarts, preserve pairing/preferences, and perform one additional controlled voice attempt.

## Global Constraints

- No recordings, transcripts, form answers, credentials, endpoints, or request/device identifiers in diagnostic records.
- No new voice timers, retries, playback gates, or call-policy changes.
- Two journal files, each at most 256 KiB; records contain fixed event names, timestamps, numeric codes, and sanitized exception categories.
- Logging failures must not escape into application behavior.
- Use existing protected signing inputs for an in-place debug update; never uninstall or clear data.
- No publication or release tags.

## Review Focus

- Release builds must not create diagnostic files.
- Rotation and process recreation must preserve recent records within the storage limit.
- Untrusted exception messages and transport errors must not reach disk.
- Full/unwritable storage must not break a call or suppress cleanup.
- Every existing call-ending branch must name its origin rather than collapse to a generic abort.

### Task 1: Journal and privacy tests

**Files:** Add `android/app/src/main/java/ru/eleven/ompaway/DebugDiagnostics.kt` and `android/app/src/test/java/ru/eleven/ompaway/DebugDiagnosticsTest.kt`.

**Interface:** A journal accepts categorical events plus optional numeric detail and a sanitized exception category. The Android wrapper initializes only when `BuildConfig.DEBUG` is true, in `noBackupFilesDir`.

- [x] Test disabled writes, append/reopen, rotation, concurrent writes, exception privacy, and unwritable storage.
- [x] Implement bounded journal and debug-only initialization.

### Task 2: Cover existing lifecycle and failure branches

**Files:** Modify `Gateway.kt`, `CallService.kt`, `VoiceForegroundService.kt`, and `security/PairedChannel.kt` beneath the application source directory.

- [x] Record call requests, foreground readiness, remote join, first capture/playback, and all teardown origins.
- [x] Preserve audio permission/focus/privacy failures, read/write result codes, queue overflow, worker exceptions, and transport failures without logging payloads.
- [x] Keep all existing decisions and cleanup behavior unchanged; never log each audio frame.

### Task 3: Verify and install

**Files:** Modify `android/app/build.gradle.kts` only to let debug builds use supplied protected signing credentials.

- [x] Run Android unit tests and build the signed debug APK using private runtime inputs.
- [x] Inspect the complete diff for privacy and unintended behavior changes.
- [x] Verify matching signer, install in place, and verify debug journaling on the handset.
- [x] Perform the single approved voice attempt, inspect the journal, and report the observed cause without claiming an unverified repair.
- [x] Commit owned source changes with generic metadata; leave private artifacts outside Git.
