# Android debug procedure

## Build

Use JDK 17, Android SDK Platform 36, Build Tools 36.0.0, platform-tools, and Gradle **8.14.3**. Point `JAVA_HOME` and `ANDROID_HOME` at those installations (or configure `sdk.dir` in an untracked `local.properties`). The Windows launcher `gradlew.bat` selects only Gradle 8.14.3 from `GRADLE_HOME` or its existing wrapper cache; it doesn't download or execute an unpinned Gradle on PATH. On a clean machine, extract the [official binary distribution](https://services.gradle.org/distributions/gradle-8.14.3-bin.zip) after comparing its SHA-256 with the [published checksum](https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256); set `GRADLE_HOME` to the extracted `gradle-8.14.3` directory. On other hosts run its `bin/gradle` directly in this directory.

Place the orchestrator-supplied Firebase **Android client** configuration for project `omp-away`, package `ru.eleven.ompaway`, at `app/google-services.json`. The Google Services plugin validates the package at build time. Build/debug must not proceed with a fake configuration, server service-account JSON or a Codex credential. Do not commit the client file, build outputs, local configuration, tokens or pairing codes.

From this directory in PowerShell:

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest
Get-FileHash -Algorithm SHA256 app/build/outputs/apk/debug/app-debug.apk
```

## Install only on the leased target

Use the shared exclusive AVD lease described by the workspace operator. Match **Pixel 10 Pro XL (99)** using `avd.ini.displayname` in the AVD's `config.ini` and its AVD ID in `emulator -list-avds`; `(99)` is not an API level. Resolve the serial via `adb devices -l`, then inspect `adb -s <serial> emu avd name`. Verify the returned ID against the leased AVD ID before any write. Boot only the leased AVD, with Google Play services and audio input/output enabled. Do not wipe it, stop someone else's emulator or run untargeted adb commands.

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

Use **Speaker: on/off** in the inbox before or during a call. The choice is saved for later calls; it defaults to off. On selects the built-in loudspeaker without changing volume. Off returns routing to Android's normal communication-device policy, including a connected headset. Hangup releases the app's speaker route and restores its previous audio mode.

For authorized physical-phone debugging, the isolated audio test can enable the same saved setting without opening the paired inbox. It plays a short tone and verifies the hardware speaker route:

```powershell
adb -s $serial shell am instrument -w -e speakerMode on -e class ru.eleven.ompaway.CallAudioTest#joinedAudioCapturesAndReachesHardwareWithoutOpeningThePairedInbox ru.eleven.ompaway.test/androidx.test.runner.AndroidJUnitRunner
```

This deliberately leaves speaker mode enabled. Use the inbox toggle, or the same command with `speakerMode off`, to turn it off. The optional desktop speech bridge accepts the same argument.

## Pair, ring and call

1. Generate a fresh pairing invite on your own desktop. Scan it in the app (camera permission is optional if using **Pair from clipboard**). Compare **all twelve emoji** in order on both screens and approve both. Do not screenshot or paste the QR payload in logs. An invalid/used ticket, mismatch or changed pin must not allow a call. To replace a pairing intentionally, revoke the old route on the desktop/relay and clear the app's storage via Settings before obtaining a new invite. There is no trust-on-error option.
2. Tap **Enable invitations**, grant the Android 13+ notification permission and enable the Desktop requests channel. No permission means no notification, not a closed Ask. Reopening the app fetches the authoritative encrypted inbox. When offline, last-known rows are visibly cached; push-only rows have no question or join control.
3. Trigger a real invite. The high-priority data-only FCM message carries `requestId`; the app posts a generic notification. Tapping it shows the matching row first without starting audio. Swiping just removes the notification. **Not now** silences that ID locally and syncs an idempotent silence to the paired desktop when reachable. Neither operation answers the Ask. Force-stopped apps do not receive FCM until launched again; OS/Play delivery is not guaranteed.
4. Grant microphone access using **Enable microphone to answer**, then tap **Answer by voice**. After authenticated join the status stays **Waiting for the desktop's voice…**. When the first approved PCM packet arrives, initialize microphone capture before starting AudioTrack: opening capture can reconfigure the phone's voice route and clip audio already playing. The first packet written changes the status to **In call**; total preparation is bounded to 90 seconds. Foreground audio focus loss, interruption, hangup, navigating away, or connection loss ends local media. The desktop is authoritative for the decision; there is no handset form-submit operation. Verify bidirectional speech, clarification, complete audible readback and explicit voice confirmation on a real call. A route with no usable hardware presentation timestamp fails the call rather than acknowledging queued or inaudible readback. The `AwayAudio` log tag reports only cumulative AudioTrack underrun counts at playout fences; a fence alone does not prove smooth or complete audible speech.
5. Answer/cancel another request from the desktop; the row and outstanding notification must disappear on sync. Try desktop wins during a call, denied microphone, screen off, duplicate invite, delayed launch and explicit Not now. Record only sanitized observations and the APK hash; do not collect microphone PCM, question text, QR, notification IDs, token dumps or private logs as evidence.
