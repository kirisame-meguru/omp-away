# Radiance Native Prototype Implementation Plan

## Goal and scope

A separately installable, reference-driven liquid-glass voice visualization. The owner replaced the earlier sculpture/dawn direction with the supplied Siri orb reference and authorized rebuilding any part that did not serve visual fidelity. This remains a prototype, not production integration or a claim of pixel-identical reproduction.

- Independent application ID `com.example.radiance.prototype`, Android API 29 minimum.
- No permissions, microphone, network, pairing, production credentials, or production lifecycle changes.
- Synthetic timing and fictional captions are explicitly labeled. No downloaded reference footage, audio, screenshots, or captured sessions ship in the repository or application.
- Publication remains limited to the authorized private prototype branch; no release, visibility change, or mirror activation.

## Reference findings

Within the listening pose, curved translucent light sheets expand, fold, overlap and settle inside a relatively stable shell. Bright folds become nearly white while outer lobes retain saturated color. Interaction recordings additionally show separate shell choreography: capsule-to-lens entry, contraction into a thinking capsule, expansion into an answer panel, and retraction on dismissal. Tablet entry includes a necked droplet separating from the bezel. These are distinct from audio-driven wave motion; the original audio-to-visual mapping remains unknown. The lower lens refracts visible background geometry; the upper cap is dark. Native-resolution inspection is required: reduced previews hide precision stair-stepping, shading bands and boundary defects.

## Architecture

Compose provides native labels and study controls above a Filament 1.56.0 SurfaceView. The scene is one full-screen quad with a precompiled material, not a procedural scene ray marcher.

The material evaluates a convex superelliptical lens, Snell refraction at entry and exit, Fresnel reflections, absorption and subtle dispersion. Its bounded five-step Newton solve finds the exit of that single lens. Three parametric light sheets use surface tangents for shaded transmission, graded emission, an achromatic fold highlight and analytic scattering lobes. The background is synthetic geometry, evaluated at refracted coordinates; this is not refraction of arbitrary Compose content. All spatial calculations and uniforms use high precision. Analytic pixel coverage and low-amplitude dithering address aliasing and output banding without a full-screen blur chain.

The Canvas fallback approximates the same silhouette, palette and movement using cached paths and gradients. It deliberately does not claim the primary renderer's optical fidelity. Auto ignores startup and switches after three consecutive two-second windows below 27 submitted frames/second. Manual GPU and 2D controls remain available. Actual presentation timing must be measured independently; submitted-frame diagnostics are not a GPU benchmark.

One mutable `ShellMotion` pose is shared across the native and fallback renderers. Closed-form critically damped springs animate width, height, upward displacement, visibility and superellipse curvature without per-frame allocations. Retargeting preserves pose and velocity; height settles behind width rather than uniformly scaling the whole object. Listen retains the approved lens exactly; Speak uses a wider, shallower shell; Connect and Silence use compact visible pills; End retracts and fades. These are prototype mode mappings, not a reproduction of the original answer UI or tablet droplet topology. Wave equations, palette and synthetic envelope remain unchanged. Background geometry stays fixed during shell movement; only the lens and its contents transform.

The system animation preference is respected by default. A labeled, local preview override does not change system settings. Reduced motion immediately settles the shell to its target and renders a still frame. Fully retracted shells stop scheduling frames until another state or surface change requires rendering. Backgrounding stops frame callbacks; destruction releases the surface and native resources.

## Build and material reproduction

Use JDK 17 and an Android SDK containing API 36 and Build Tools 36.0.0. Supply SDK/JDK locations through the normal environment or untracked local configuration.

From the Android root:

```powershell
./gradlew.bat :prototype:testDebugUnitTest :prototype:assembleDebug
```

The compiled Android material is checked in. After editing `prototype/src/main/materials/orb.mat`, use the `matc` executable from Filament 1.56.0:

```powershell
./prototype/tools/compile-materials.ps1 -Matc matc
```

Equivalent command, from the prototype directory, on a platform with the pinned compiler:

```text
matc --platform mobile --api opengl --api vulkan --optimize-size -o src/main/assets/orb.filamat src/main/materials/orb.mat
```

The compiler and runtime versions must stay aligned. Only mobile OpenGL and Vulkan variants are packaged.

## Acceptance

- Build and deterministic choreography, quality-policy and shell-transition tests pass, including interruption, repeated targets, frame-rate independence, dismissal and reduced motion.
- Inspect original-resolution PNGs and 1:1 crops, without resizing or sharpening. Use native-resolution recordings to assess temporal behavior separately.
- Compare shell displacement, shaded folds, highlight softness and resting/active motion with the reference. Do not call subjective fidelity or pixel identity proven by unit tests.
- Measure actual SurfaceFlinger presentation intervals during sustained motion; distinguish capture overhead and warmup from steady state.
- Exercise mode controls, backgrounds, reduced motion, explicit override, GPU/2D/Auto, pause/resume and resource cleanup.
- Compare the settled listening-wave crop against the prior renderer at native resolution; verify mode transitions and rapid reversals in recordings, not only endpoint screenshots. Switching GPU/2D must retain the shared shell pose.
- Audit intended files and generated material for private data; commit only owned changes using a generic project identity. Publish from an isolated clean clone of the authorized private repository.

## Limitations

The synthetic envelope is a hand-authored motion study, not the original audio or live voice analysis. The reference's exact proprietary shader, optical parameters and temporal response are unknown. The Canvas path is an intentionally cheaper approximation. Physical older-device fallback and long thermal/battery runs require separate hardware verification; a short flagship test cannot establish those claims.
