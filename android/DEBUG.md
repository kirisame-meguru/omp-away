# Android debug procedure

## Build

Use JDK 17, Android SDK Platform 36, Build Tools 36.0.0, platform-tools, and Gradle **8.14.3**. Point `JAVA_HOME` and `ANDROID_HOME` at those installations (or configure `sdk.dir` in an untracked `local.properties`). The Windows launcher `gradlew.bat` selects only Gradle 8.14.3 from `GRADLE_HOME` or its existing wrapper cache; it doesn't download or execute an unpinned Gradle on PATH. On a clean machine, extract the [official binary distribution](https://services.gradle.org/distributions/gradle-8.14.3-bin.zip) after comparing its SHA-256 with the [published checksum](https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256); set `GRADLE_HOME` to the extracted `gradle-8.14.3` directory. On other hosts run its `bin/gradle` directly in this directory.

Place the orchestrator-supplied Firebase **Android client** configuration for project `omp-away`, package `ru.eleven.ompaway`, at `app/google-services.json`. The Google Services plugin validates the package at build time. Build/debug must not proceed with a fake configuration, server service-account JSON or a Codex credential. Do not commit the client file, build outputs, local configuration, tokens or pairing codes.

From this directory in PowerShell:

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest
Get-FileHash -Algorithm SHA256 app/build/outputs/apk/debug/app-debug.apk
```

The independent visual prototype is opt-in: add `-PincludePrototype=true` and target `:prototype:assembleDebug`. Normal `:app` builds neither configure nor package the prototype; normal package, version and signing configuration remain unchanged.

## Touch answers on home

Questions and native answer forms appear on the home screen alongside the compact Radiance orb. Defaults are retained; required, length and numeric checks run locally, with authoritative validation on the desktop. Option notes are sent as `{name, value, text}`; only the desktop supplies canonical labels. Drafts stay in application memory, never saved-instance parcels.

Check submit receipts, disabled options, checkbox/radio defaults, Other answers and notes, rotation, keyboard resizing, and reconnect during submission. Accepted/stale/uncertain receipts must not permit duplicate submission. A missing receipt stays unconfirmed; verify the desktop rather than automatically retrying. Legacy question details, proposed answers, invitations and optional per-question voice remain available.

## Install only on the leased target

Use the shared exclusive AVD lease described by the workspace operator. Identify the approved test emulator using `avd.ini.displayname` in its `config.ini` and its exact AVD ID in `emulator -list-avds`. Resolve the serial via `adb devices -l`, then inspect `adb -s <serial> emu avd name`. Verify the returned ID against the leased AVD ID before any write. Boot only the leased AVD, with Google Play services and audio input/output enabled. Do not wipe it, stop someone else's emulator or run untargeted adb commands.

```powershell
$serial = Read-Host 'Serial of the verified leased AVD'
adb -s $serial emu avd name
adb -s $serial install -r app/build/outputs/apk/debug/app-debug.apk
adb -s $serial install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s $serial shell am instrument -w ru.eleven.ompaway.test/androidx.test.runner.AndroidJUnitRunner
adb -s $serial shell am start -n ru.eleven.ompaway/.InboxActivity
```

Do not use `:app:connectedDebugAndroidTest` on a paired device: its cleanup uninstalls the app and removes pairing. Use the explicit serial-directed install/instrument commands above to preserve data. A physical phone requires its owner's permission before installing or starting an audio test; emulator results do not prove physical-phone playback.

## Speaker mode

Use **Speaker: on/off** during a call, or **Speaker** in its question details. The choice is saved for later calls; it defaults to off. On selects the built-in loudspeaker without changing volume. Off returns routing to Android's normal communication-device policy, including a connected headset. Hangup releases the app's speaker route and restores its previous audio mode.

For authorized physical-phone debugging, the isolated audio test can enable the same saved setting without opening the paired inbox. It plays a short tone and verifies the hardware speaker route:

```powershell
adb -s $serial shell am instrument -w -e speakerMode on -e class ru.eleven.ompaway.CallAudioTest#joinedAudioCapturesAndReachesHardwareWithoutOpeningThePairedInbox ru.eleven.ompaway.test/androidx.test.runner.AndroidJUnitRunner
```

This deliberately leaves speaker mode enabled. Use the inbox toggle, or the same command with `speakerMode off`, to turn it off. The optional desktop speech bridge accepts the same argument.

## Pair, ring and call

1. Generate a fresh pairing invite on your own desktop. Scan it in the app (camera permission is optional if using **Pair from clipboard**). Compare **all twelve emoji** in order on both screens and approve both. Do not screenshot or paste the QR payload in logs. An invalid/used ticket, mismatch or changed pin must not allow a call. To replace a pairing intentionally, revoke the old route on the desktop/relay and clear the app's storage via Settings before obtaining a new invite. There is no trust-on-error option.
2. Tap **Enable invitations**, grant the Android 13+ notification permission and enable the Desktop requests channel. No permission means no notification, not a closed Ask. Reopening the app fetches the authoritative encrypted inbox. When offline, last-known rows are visibly cached; push-only rows have no question or join control.
3. Trigger a real invite. The high-priority data-only FCM message carries `requestId`; the app posts a generic notification. Tapping it shows the matching row first without starting audio. Swiping just removes the notification. **Not now** silences that ID locally and syncs an idempotent silence to the paired desktop when reachable. Neither operation answers the Ask. Force-stopped apps do not receive FCM until launched again; OS/Play delivery is not guaranteed.
4. Tap the question's optional **Answer by voice** control; microphone permission is requested only for voice, never touch answers. After authenticated join the status stays **Waiting for the desktop's voice…**. The first approved PCM packet initializes microphone capture before AudioTrack, avoiding route changes clipping audio. The first packet written changes the status to **In call**; preparation is bounded to 90 seconds. The native orb follows listening, thinking after a final caller caption, and speaking from presented playback; animation and rendering settings remain independent. The foreground voice service preserves authorized background calls; audio focus loss, interruption, hangup or connection loss ends local media. The desktop remains authoritative for both touch submissions and explicit voice confirmation. Verify bidirectional speech, complete audible readback and confirmation on a real call. Missing hardware presentation timestamps fail the call rather than acknowledging queued or inaudible readback. `AwayAudio` reports cumulative underrun counts at playout fences only; a fence alone does not prove complete audible speech.
5. Answer/cancel another request from the desktop; the row and outstanding notification must disappear on sync. Try desktop wins during a call, denied microphone, screen off, duplicate invite, delayed launch and explicit Not now. Record only sanitized observations and the APK hash; do not collect microphone PCM, question text, QR, notification IDs, token dumps or private logs as evidence.
