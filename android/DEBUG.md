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

Questions and native answer forms appear over the fullscreen Radiance scene. No orb or reserved orb header is present while voice is inactive. During a voice call, the lens emerges from the top as a transparent foreground overlay above headers and content, without changing their layout. It follows connecting, listening, thinking and speaking, then retracts when the call ends; reduced-motion mode changes poses immediately. Defaults are retained; required, length and numeric checks run locally, with authoritative validation on the desktop. Option notes are sent as `{name, value, text}`; only the desktop supplies canonical labels. Drafts stay in application memory, never saved-instance parcels.

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

## Rooted physical phone: synthetic speech without an acoustic loop

Use `tools/acceptance/rooted_audio.py` and its adjacent Frida agent only on an explicitly authorized test phone and a synthetic Away conversation. This works with the ordinary paired app, including a release-mode APK; it does not replace the app, pairing, relay, provider, native-live controller, or coding agent.

The agent replaces successful native `AudioRecord::read` buffers with queued PCM, or silence between clips. The original reads still provide timing and error results. It observes only bytes accepted by the real `AudioTrack::write`; it does not fabricate playback acknowledgements, captions, answers, or call completion. Microphone permission and audio-focus checks remain active. The microphone hardware can still be active, but its captured samples are not forwarded while the hook is healthy.

This verifies the handset's software audio/transport path and real-provider conversation. It does **not** prove physical microphone sensitivity or audible loudspeaker quality. Keep speaker mode enabled when also checking the actual communication route; use the acoustic procedure above for hardware audibility.

### Prepare root and the authenticated local instrument

Tested with an arm64 Android 16 handset and matching Frida **17.9.11** client/server. Install the Python client outside the checkout. Obtain the matching Android server from [official Frida releases](https://github.com/frida/frida/releases) and verify the release asset's SHA-256 before extracting it. Do not commit the binary, credentials, device identifiers, or captured data.

1. Select the authorized device explicitly. Check `adb -s $serial shell id`. Root may be provided by `adbd` even when `su` is absent from the shell PATH. If authorized, use `adb -s $serial root`; wireless ADB can restart on a new port and the command can time out after successfully changing mode. Use `adb mdns services` or the phone's Wireless debugging page, reconnect to the **same verified phone**, and check for `uid=0` again. Do not infer success from the root command alone.
2. Preserve existing diagnostic recordings before a debug call can rotate them. Keep backups outside Git. Never clear app data, replace pairing, disable SELinux, or kill an unrelated instrumentation server.
3. Set the desired app language before attaching. Record the app PID after any installation or process restart. Choose an unused phone-side port; the server must listen only on loopback, with authentication.

From `android/`, in PowerShell 7:

```powershell
$serial = Read-Host 'Verified wireless ADB endpoint or device serial'
$artifacts = Read-Host 'Existing private artifacts directory outside every repository'
$server = Read-Host 'Verified matching Android Frida server binary'
$devicePort = 27042 # Change if occupied; never take over an existing listener.
$remote = '/data/local/tmp/away-root-audio-' + [guid]::NewGuid().ToString('N')
$token = [guid]::NewGuid().ToString('N')
adb -s $serial shell mkdir -m 700 $remote
adb -s $serial push $server "$remote/frida-server"
adb -s $serial shell chmod 700 "$remote/frida-server"
$serverPid = [int](adb -s $serial shell "nohup $remote/frida-server --listen=127.0.0.1:$devicePort --policy-softener=internal --token=$token > $remote/server.log 2>&1 < /dev/null & echo `$!")
$localPort = [int](adb -s $serial forward tcp:0 "tcp:$devicePort")
$appPid = [int](adb -s $serial shell pidof -s ru.eleven.ompaway)
@{ port=$localPort; token=$token; pid=$appPid } |
  ConvertTo-Json | Set-Content -Encoding utf8 "$artifacts/connection.json"
@{} | ConvertTo-Json | Set-Content -Encoding utf8 "$artifacts/control.json"
python ../tools/acceptance/rooted_audio.py `
  --connection "$artifacts/connection.json" `
  --control "$artifacts/control.json" `
  --out "$artifacts/capture"
```

Keep the controller running in its own terminal. The capture directory must be new; existing artifacts are never overwritten. Redirecting the remote server's standard streams avoids an ADB shell waiting on inherited descriptors. Confirm `capture/state.json` reports `ready: true` and no errors before opening the call. The agent refuses non-Away processes and requires the two expected native audio exports; do not weaken those checks when attaching fails.

### Exercise actual speech and continuity

Use mono, signed little-endian PCM16 WAV at **24,000 Hz**, no longer than 60 seconds per clip. For example, convert an existing synthetic speech file:

```powershell
ffmpeg -i "$artifacts/speech-source.wav" -ac 1 -ar 24000 -c:a pcm_s16le "$artifacts/recall.wav"
```

In another PowerShell terminal, set the same private `$artifacts` path and replace control files atomically:

```powershell
function Send-AudioControl($command) {
  $temporary = "$artifacts/control.tmp"
  $command | ConvertTo-Json | Set-Content -Encoding utf8 $temporary
  [IO.File]::Move($temporary, "$artifacts/control.json", $true)
}
Send-AudioControl @{ id='recall-1'; op='queue'; wav="$artifacts/recall.wav" }
```

Use a fresh command ID for every deliberate utterance. Within one controller run, a repeated ID is ignored; queuing while another clip remains active is rejected rather than silently mixing or dropping speech. Start each run with an empty control file as above so an old utterance cannot be replayed. Wait for the matching `consumed` event before queuing another clip, and let the assistant finish its response unless interruption is the behavior under test.

For a continuity check, first submit a synthetic code through a real touch form. Open a later voice question in the **same desktop conversation**. Inject a Russian request to recall the previous code, without including that code in the audio. Verify the real Russian caption/response, then inject a decision and an explicit request to hand it back and end the call. Inspect the actual coding-agent response and end-call tool result; consumed PCM or a retired native Ask alone is not success.

`state.json` and `events.jsonl` record hook readiness, byte counts, consumed clip IDs, errors, and closure. `playback.wav` contains accepted handset output and is finalized when the controller stops. These are private test artifacts, not publishable evidence; they can contain synthetic conversation text/audio. Positive output-byte counts include silence, so inspect nonzero PCM and actual captions/results rather than treating byte growth as speech proof.

### Close and restore

1. End the real test call through its normal UI or agent tool and verify it ended. **Do this before detaching:** stopping the hook restores ordinary microphone reads.
2. Send `Send-AudioControl @{ id='stop-1'; op='stop' }`. Wait for the controller to exit and `state.json` to report `closed: true`. An unexpected app exit or transport disconnect is an error, not a passing test; close any remaining handset call.
3. Verify `/proc/$serverPid/exe` still points to the server in the uniquely created `$remote` directory, then stop only that PID. Remove only the ADB forward created above (`adb -s $serial forward --remove "tcp:$localPort"`) and that owned temporary device directory. Never use a global `pkill`, remove shared servers, or delete retained app recordings.
4. Restore temporary language/debugging settings as appropriate. If root ADB was enabled only for this test, return to the previous mode with `adb -s $serial unroot`, then rediscover/reconnect the wireless endpoint if needed. Keep private recordings and rollback backups outside the repository.

For release-capture verification, inventory and hash the existing diagnostic files before an in-place release-mode update, perform a real call, then inspect them with authorized root access. Release mode prevents **new** diagnostic capture; it does not erase old debug audio/transcripts. Byte-identical retained files after a real call establish both facts without deleting user data. The Frida output recording is external test instrumentation and must not be confused with the app's own diagnostic recorder.

## Pair, ring and call

1. Generate a fresh pairing invite on your own desktop. Scan it in the app (camera permission is optional if using **Pair from clipboard**). Compare **all twelve emoji** in order on both screens and approve both. Do not screenshot or paste the QR payload in logs. An invalid/used ticket, mismatch or changed pin must not allow a call. To replace a pairing intentionally, revoke the old route on the desktop/relay and clear the app's storage via Settings before obtaining a new invite. There is no trust-on-error option.
2. Tap **Enable invitations**, grant the Android 13+ notification permission and enable the Desktop requests channel. No permission means no notification, not a closed Ask. Reopening the app fetches the authoritative encrypted inbox. When offline, last-known rows are visibly cached; push-only rows have no question or join control.
3. Trigger a real invite. The high-priority data-only FCM message carries `requestId`; the app posts a generic notification. Tapping it shows the matching row first without starting audio. Swiping just removes the notification. **Not now** silences that ID locally and syncs an idempotent silence to the paired desktop when reachable. Neither operation answers the Ask. Force-stopped apps do not receive FCM until launched again; OS/Play delivery is not guaranteed.
4. Tap the question's optional **Answer by voice** control; microphone permission is requested only for voice, never touch answers. After authenticated join the status stays **Waiting for the desktop's voice…**. The first approved PCM packet initializes microphone capture before AudioTrack, avoiding route changes clipping audio. The first packet written changes the status to **In call**; preparation is bounded to 90 seconds. The native orb follows listening, thinking after a final caller caption, and speaking from presented playback; animation and rendering settings remain independent. The foreground voice service preserves authorized background calls; audio focus loss, interruption, hangup or connection loss ends local media. The desktop remains authoritative for both touch submissions and explicit voice confirmation. Verify bidirectional speech, complete audible readback and confirmation on a real call. Missing hardware presentation timestamps fail the call rather than acknowledging queued or inaudible readback. `AwayAudio` reports cumulative underrun counts at playout fences only; a fence alone does not prove complete audible speech.
5. Answer/cancel another request from the desktop; the row and outstanding notification must disappear on sync. Try desktop wins during a call, denied microphone, screen off, duplicate invite, delayed launch and explicit Not now. Record only sanitized observations and the APK hash; do not collect microphone PCM, question text, QR, notification IDs, token dumps or private logs as evidence.
