# Native UI audit

Status: implementation, rendered inspection, and real-device UI acceptance complete. Acoustic and delivery limits are recorded below.

## Approved direction

- Product: Answer desktop coding-agent questions from the phone, by touch or voice.
- Character: Quiet, precise, slightly warm.
- World: A pocket intercom for the active coding session.
- Moments: The actual question and audio-responsive glass lens.
- Signature: Consistent, compact desktop/session provenance and answer status.

Use near-opaque neutral panels, compact hierarchy, distinct primary actions, and restrained corners. Preserve the full-screen reference backdrop and foreground audio-responsive lens. Do not introduce a large empty region to accommodate the lens. Keep authored rich content and security-verification emoji.

## Evidence boundary

Directly inspected 406 isolated baseline compositor captures, including scroll segments, native text selection, both renderers, appearance combinations, a 320 × 640 dp viewport at 200% font scale, and a short 400 × 280 dp viewport. Separately inspected 12 normal-app and Android settings/permission captures, real isolated scanner/permission screens, and 18 partial real-audio frames across initial and repositioned-phone attempts. Captures and device/session details remain outside the repository.

Hosted catalog scenarios use production layouts with synthetic state. They prove rendering, not live networking, submission, pairing, lifecycle, permission grants, or audio. The narrow viewport is not evidence of actual rotation. No global display settings were changed for this catalog.

Both initial acoustic scenarios reached actual playback but failed to complete a caller turn. Their connecting/listening/speaking images were recovered and inspected; final-caption coverage is missing. A teardown broken-pipe exception prevented normal evidence-manifest cleanup. The corrected cleanup now preserves partial manifests and reports the original failure without crashing. Neither repositioned-phone attempt reached caller-stimulus playback: the opening-response gates failed first. Those retries do not diagnose phone placement or caller recognition. These runs are not acceptance passes.

The original test system's secure-window override was enabled (`window_ignore_secure=1`), stripping secure-window flags. That global policy was left unchanged. Evidence from that system cannot demonstrate screenshot exclusion. The subsequent Android 16 reinstall is a separate acceptance environment; the old override finding must not be assumed to apply to it.

## Findings

| Area | Observed problem | Required correction |
| --- | --- | --- |
| Question list and details | Repeated screen headings and large provenance compete with the question | One clear page heading; smaller consistent session/status metadata |
| Actions | Submission, navigation, dismissal, and optional notes look equally important | Distinct primary action; quiet secondary/navigation controls |
| Surfaces | Translucent lavender layers expose distracting backdrop boundaries beneath text | One neutral ramp; near-opaque reading surfaces |
| Form choices | Disabled labels resemble enabled choices | Explicit disabled text/control states without changing authored content |
| Validation | Field error and distant submission notice divide attention | Keep actionable errors near the relevant input |
| Settings | Verbose explanations and oversized sections lengthen the page | Shorter copy and compact spacing without losing privacy semantics |
| Settings controls | Switch tracks use unrelated teal; Auto/GPU labels split at large font | Consistent state palette; renderer choices that fit scalable text |
| Pairing and relay recovery | Repeated headings and retained-key explanations | Concise hierarchy; retain trusted-origin and credential warnings |
| Active panels | Foreground lens covers titles and the first card | Fit the lens within a deliberate noninteractive header region; never cover actions |
| Voice at large font | Speaker, Questions, and Hang up split inside words | Responsive controls; retain minimum 48 dp targets and readable labels |
| Voice captions | Large status heading and fixed lower-screen allocation leave little reading space | Compact status hierarchy and viewport-aware caption layout |
| Incoming call | Large mostly empty panel; Answer and Decline lack priority distinction | Content-led sizing and distinct answer action; retain private lock-screen copy |
| Incoming call in short windows | Fixed vertical placement reduces the explanation to a clipped strip, even while scrolling | Use available height; keep the complete explanation readable alongside reachable actions |
| Scanner camera denial | Library dialog incorrectly suggests restarting the device and uses an unrelated legacy theme | Handle permission denial explicitly with truthful recovery and clipboard fallback |
| Waves | Quiet/listening/speaking baseline appears below lens center in both renderers | Measure rendered geometry and remove unjustified baseline offset |
| 2D backdrop | Abrupt horizontal dark boundary | Smooth scrim matching the GPU scene's fade region |

The native Cut/Copy/Share/Select all toolbar is visible and usable. Long forms, Other/notes, keyboard submission controls, horizontally scrolling code/tables, and all 12 verification emoji remain reachable in inspected configurations. Do not replace authored formatting with flattened text.

## Source correlations

- Original GPU waves used a negative vertical baseline; Canvas waves and their radial highlight used the corresponding positive baseline. The GPU quiet lobe had an additional vertical term. Refraction must be considered when checking rendered centering.
- Original-resolution quiet speaking-pose captures place the lens center near y=255.5 px. The central wave peak is approximately 14.5 px lower for GPU and 12.5 px lower for 2D. These are baseline screenshot measurements, not post-fix acceptance.
- The original 2D renderer painted a constant-opacity rectangle beginning at 58% of viewport height. The GPU instead applied a smooth scrim from 53% to 72%.
- Original voice controls allocated equal widths to three text buttons regardless of font scale. Caption height was a fixed viewport fraction.
- The original foreground lens was reparented above the panel and kept its large top-anchored placement when a panel opened.

## Ordered implementation passes

1. Spacing: 4 dp rhythm, consistent padding and equivalent control sizing.
2. Color: one neutral ramp, readable text roles, consistent control states.
3. Icons: consistent native-scale assets; no decorative emoji removal from authored/security content.
4. Copy: concise interface language; preserve privacy and submission distinctions.
5. Typography: question-first hierarchy, scalable sp, restrained weights and metadata.
6. Layout: responsive controls, short-window support, no foreground/content collisions.
7. Component details: restrained nested corners, visible selection/disabled/focus/error states.
8. Visuals: centered waves, smooth fallback backdrop, preserved full-screen scene.
9. Motion: purposeful state transitions, existing motion preference respected, no animated layout properties.

## Implementation and batch checks

- Shared neutral colors and disabled states; primary submission, pairing, restoration, verification, and answer actions; quiet navigation and optional actions.
- Compact provenance and page hierarchy, native microphone asset, scalable text, consistent spacing and restrained corners.
- Panel lens fitted to a measured noninteractive toolbar slot; full-screen reference scene retained. Voice content and secondary actions scroll together, with stacked controls at narrow widths or large font scales. Hang up stays in the fixed voice header, outside long captions.
- Incoming invitation uses content-led height with the entire explanation and actions in one scroll region. Renderer choices are vertical.
- Camera permission is requested before opening the scanner; denial remains in the app with retry/clipboard recovery. Actual camera faults still use the scanner's camera-error handling.
- Both wave baselines and the quiet lobe are centered in source coordinates. The fallback scrim is cached and fades across the GPU fade region. The material compiled with Filament compiler version 56.
- Existing audio-driven shell transitions and animation preference retained; layout properties are not animated.
- Isolated APKs built successfully. JVM checks: 20 app and 13 renderer tests passed. Desktop typecheck passed; 323 desktop tests passed. Python acoustic-runner syntax parsed successfully.
- These checks do not substitute for rendered inspection, real permission recovery, final-caption coverage, or end-to-end submission.

## Direct inspection and installed update

- Directly inspected all 406 baseline hosted frames and 431 initial post-change frames, including narrow/double-font and short-landscape configurations.
- Fixed two additional screenshot-proven form defects: authored placeholders now wrap outside editors without changing input types, values, or validation; native shared table columns keep headers aligned with data. Directly inspected all 47 resulting normal-size and double-font captures, including horizontal scrolling and keyboard-visible submission.
- Original-resolution quiet-frame measurements put the GPU wave peak 1.5 px below the measured lens-edge midpoint and the 2D peak 1 px below it, versus approximately 14.5 px and 12.5 px before the change.
- Inspected actual isolated-app camera prompts, denial, retry, permanent-denial navigation to Android settings, grant recovery into the scanner, landscape rotation, and cancellation. Portrait rotation lock was restored. Normal-app permission grants were not changed.
- The notes-context acoustic scenario completed two recognized caller turns and six assistant finals with clean teardown, no transport errors, and no unintended submission. All six real-call captures were inspected. The direct scenario failed before caller playback with no observed opening response; its connecting capture was inspected. This is not a full acoustic pass.
- Before the testing bypass, the focused native run passed all 22 tests. No new regression tests or verification suites were run after the bypass. Subsequent builds produced the APKs required for screenshots and installation.
- Installed normal-package version 1.0.13 / 1000013 as an upgrade. Pairing digest, preference-file digests/absence, UID, signer, and microphone/camera/notification grants were unchanged. The upgraded inbox visibly reconnected to the desktop.
- Completed a real paired synthetic request on the installed update: numeric validation rejected an out-of-range value; text, numeric, and per-option-note drafts survived navigation; the desktop received the expected values once; the inbox displayed “Answer submitted.” Pairing remained unchanged.
- The user subsequently reinstalled Android 16, removing the old normal-app pairing. This is a new baseline, not an app-upgrade regression. Re-established pairing through the actual enrollment and verification UI, compared every displayed verification symbol, and confirmed persistence and reconnection after removing temporary instrumentation.
- On Android 16, directly inspected the isolated app's first and second microphone prompts and permanent-denial navigation into system settings. Granted microphone access through the actual settings control and returned to the app.
- Exercised notification denial, retry, permanent-denial settings recovery, and enabling notifications through Android's actual toggle. Screenshot blocking now demonstrably excludes app content on Android 16; switching it off in the isolated app restores capture visibility.
- Inspected the real private incoming-call activity over the lock screen. Decline dismisses it; Answer reaches Android's credential gate rather than starting audio. Subsequent device administration used a temporary root dismissal, leaving the PIN configured and SELinux enforcing; this is not evidence of a completed PIN-authentication flow.
- The first post-reinstall acoustic attempt was interrupted because a stale numeric output index selected headphones. Stopped that run and removed its owned stale transport mapping. Subsequent playback resolves the external dock speakers by exact endpoint name and host API within the playback process; it refuses missing or ambiguous matches.
- With the speakable opening request and the correct physical output, the Android 16 direct scenario produced a finalized, audible opening and then played one caller stimulus. It still failed full acceptance: no caller transcript/final was observed, despite a subsequent assistant response. No answer was submitted; teardown completed without transport errors. Directly inspected all five connecting/listening/speaking captures; final-caption coverage remains incomplete.
- On the newly paired Android 16 normal app, received a real background notification and inspected its private lock-screen copy. “Not now” silenced the invitation without removing the pending form. Text, numeric, and option-note drafts survived navigation; a single submission reached the desktop with the expected values, and the inbox confirmed submission. The new pairing digest remained unchanged.
- Inspected normal appearance, privacy, notification, and full-screen-permission settings. Restored the original screenshot-blocking and ringing preferences after inspection.
- A later two-request invitation walkthrough did not produce a recorded push wakeup or automatic full-screen launch. Stored invitation membership remained false; foreground synchronization alone exposed the pending item. Shared desktop routing reports immediate invitations enabled. Both synthetic requests were retired without submission. This does not establish automatic ringing, expiry, or decline acceptance and is not evidence of an Android full-screen-policy failure.
- Corrected acoustic diagnostic turn attribution: caller-final events can follow the beginning of an assistant reply and must not themselves mark that reply interrupted. A subsequent dock-routed Android 16 direct dialogue passed the unchanged acceptance gates with three recognized caller turns, four assistant finals, one takeover, one native completion, one live stop, clean resumption, and zero submissions or transport errors. Hardware instrumentation passed; all six connecting, listening, speaking, and final-caption captures were directly inspected.
- The Android 16 contextual dialogue recognized both caller turns and rendered final captions, but one question lost its interrogative phrase in recognition and received an acknowledgment rather than the requested explanation. It remains a failed contextual scenario. A later attempt never established the handset bridge; its cleanup force-stop produced a process-crashed instrumentation result, not evidence of a new application exception.
- A subsequent normal-app walkthrough received genuine push wakeups and automatically presented the private full-screen invitation over the awake secure lock screen. Let the first invitation expire: the activity dismissed and the request remained pending but silenced. Declined the second through its actual control: the activity dismissed and the request again remained pending but silenced. The desktop confirmed zero submissions and retired both synthetic requests. This verifies awake lock-screen delivery; it does not explain the earlier missing wakeups while the display was asleep.
- Final normal-app verification: version 1.0.13 / 1000013, connected inbox with no pending synthetic requests, unchanged new pairing, original ringing and screenshot-blocking preferences restored, notification and full-screen permissions allowed. Camera and microphone remain unrequested in the normal package after the OS reinstall; isolated-package permission recovery and audio were exercised separately. Display size, density, font scale, and portrait lock remain unchanged. Removed temporary root instrumentation, its executable, and its owned forwarding entry; SystemUI remains running and SELinux enforcing.

## Inbox refresh and compact header

- Replaced the inbox navigation buttons with an accessible 48 dp Settings gear and pull-to-refresh. Connection status sits below Questions; actionable recovery and submission feedback remain available.
- The complete panel, including its heading and gear, follows the pull. The native indicator enters from the display's top edge, above the panel; the full-screen backdrop stays fixed. Refresh requests a snapshot without retiring a verified connection. Unpaired, busy, and active-call states cannot start a refresh.
- Empty inboxes consistently say “No pending questions.” before and after synchronization.
- The initial icon/navigation/unpaired-gating instrumentation check passed (one focused test). Built the corrected whole-panel implementation and directly inspected real header- and body-origin pulls on the normal app, including the indicator entering from the display edge, below-threshold cancellation, completed refresh, and restoration of the panel position. Settings navigation and scrolling remained usable.
- Installed version 1.0.14 / 1000014 as an upgrade. A post-upgrade relay rejection cleared through a subsequent pull retry; the final inbox was connected. Pairing digest, UID, and permission grants were unchanged. Restored screenshot blocking, verified ringing unchanged, and preserved display settings. Captures remain outside the repository.

