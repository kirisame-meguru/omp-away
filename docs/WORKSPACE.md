# Workspace

The root repository owns cross-component specifications, plans and acceptance evidence. `plugin/`, `android/` and `relay/` are independent Git repositories, not submodules. Work and commit in the repository that owns the change. Do not initialize or replace an existing checkout. Keep cloud credentials, control links and private keys outside all repositories.

Desktop integration belongs in `plugin/`; handset presentation and FCM reception belong in `android/`; public HTTPS, invitation delivery and opaque tunnel routing belong in `relay/`. The cross-component contract is in [the design](superpowers/specs/2026-11-22-omp-away-design.md) and [the implementation plan](superpowers/plans/2026-11-22-omp-away.md).

Use the Android SDK's `emulator -list-avds` and each AVD's `avd.ini.displayname` to identify the explicitly approved test emulator. Acquire the shared per-AVD exclusive lease before device use, resolve the serial with `adb -s <serial> emu avd name`, keep audio enabled and release only owned resources. Do not substitute another shared AVD without authorization. No `jtarchive` commands that start or stop its backend are needed here.
