# Away release installation and operations

## Distribution contract and evidence

A release is one immutable `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-beta.N` tag at one exact monorepo commit. It contains all components; beta releases are marked as prereleases on the host. Minor and patch are each 0–999; beta numbers are 1–98. Published Android codes through v1.0.22 are preserved. From v1.0.23 onward, Android `versionCode = (major * 1000000 + minor * 1000 + patch) * 100 + channel`, where channel is the beta number or 99 for stable; codes must not exceed 2100000000. This permits in-place beta-to-beta and beta-to-stable upgrades. Publish tags in increasing semantic order; never move a published tag or reuse a version for different bytes. The archive/tag is the plugin distribution version; the source package retains its existing private package version and pinned omp compatibility. Nothing is published to npm.

The expected **12 assets** are seven relay archives, one signed APK, one source plugin ZIP, this `INSTALL.md`, `release.json`, and `SHA256SUMS`. `release.json` records exact commit, tag, Android code, toolchains, target matrix, and the complete expected set. `SHA256SUMS` covers every asset except itself. Host-generated source ZIP/tar downloads are not installer assets.

**Local acceptance evidence:** all seven relay targets built with Go 1.26.0. Windows amd64 and Linux amd64 passed native race tests and actual loopback startup/health/shutdown checks; the other five targets are cross-build evidence only. The Windows plugin archive passed a clean isolated stock omp 19.1.0 installation, locked helper provisioning/imports and plugin doctor (one expected missing package-manifest warning for a local link, no errors). Android lint/JVM gates and 27 instrumentation tests passed on each of API 29, 31 and 34; same-key signed clean installation and upgrade preserved a changed presentation preference on all three. Local Android builds used Oracle JDK 17.0.12, not the pinned CI JDK. These checks do not claim production Firebase delivery, a complete production relay round trip, migration from debug signing, or live GitHub publication.

| Relay target | Archive | Build policy | Runtime/deployment limits |
| --- | --- | --- | --- |
| Linux amd64 | tar.gz | `CGO_ENABLED=0` | Native race tests and non-root startup/health/graceful shutdown passed |
| Linux arm64 | tar.gz | cross-compiled, no CGO | Native startup/health not yet demonstrated |
| Linux arm/v7 | tar.gz | `GOARCH=arm GOARM=7`, no CGO | Experimental; ARMv7 CPU required, 32-bit mmap/address-space limits |
| Windows amd64 | zip | cross-compiled, no CGO | Native handle/DACL race tests and startup/health/termination passed |
| Windows arm64 | zip | cross-compiled, no CGO | Same native DACL policy; no native runner evidence |
| macOS amd64 | tar.gz | cross-compiled, no CGO | Unnotarized CLI; native startup/health and operator security approval required |
| macOS arm64 | tar.gz | cross-compiled, no CGO | Unnotarized CLI; no native runner evidence |

Investigation: bbolt 1.5.0 is pure Go and its own cross-architecture matrix includes Linux arm, arm64, amd64 and Windows amd64/arm64. Firebase/Google API and coder/websocket dependencies are Go libraries, not an excuse to equate `go tool dist list` with verified support. The actual complete relay build is the release gate. BSD, AIX, Solaris, Android/iOS-as-relay, Windows 386, Linux 386/armv6/mips/ppc/s390x/riscv/loong64, WASM and other targets are excluded: no maintained deployment/security/runtime acceptance coverage. Failure of one listed target fails the release; do not silently omit its asset.

## Verify before installation

Obtain assets only from the explicitly configured repository release over authenticated HTTPS. Keep the original complete asset directory for recovery. From a matching trusted source checkout:

```sh
python tools/release/release.py verify /absolute/path/to/release-assets
```

This rejects missing/extra files, duplicate checksum entries, traversal names, symlinks and changed bytes. Checksums detect transfer errors and inconsistent reruns, not a compromised release account: authenticate the host/tag/source and protect signing identities. Compare `release.json` with the intended source commit. Extract archives only after verification. Do not run a script from an untrusted archive merely to verify that same archive.

## Relay deployment and update

Use a non-root Linux service account and a local HTTPS/WSS reverse proxy. The relay refuses a public bind and accepts literal loopback `AWAY_LISTEN` (default `127.0.0.1:8787`). TLS termination, WebSocket forwarding, request limits and firewalling are required; never expose the backend directly. The source `relay/deploy/away-relay.service` is the systemd template. Review the source proxy template for your own hostname before using it; never copy a deployment's endpoint into a redistributed artifact.

1. Extract the matching archive. Run `away-relay --version` and compare tag/commit/platform to `release.json`.
2. Install the executable under a root-owned service binary directory. Create `AWAY_STATE_DIR` as an absolute private directory (0700) owned by the service; keep its routing database private (0600). Do not place it under the release directory or erase it during updates.
3. Set `AWAY_DESKTOP_TOKEN_FILE` to an absolute protected regular file (0600) containing the existing desktop token. Keep it outside source, logs and archives. Linux systemd `LoadCredential` is supported. Desktop and relay must use the same token.
4. Configure Firebase Application Default Credentials **only on the relay**. `GOOGLE_APPLICATION_CREDENTIALS` may reference a protected server-side credential file. `GOOGLE_CLOUD_PROJECT` selects the Firebase project explicitly; otherwise the relay uses the ADC project ID. Missing/invalid project fails startup. The explicit ID must be 6–30 lowercase letters/digits/hyphens, begin with a letter and end with a letter/digit. The selected project must match the Android client project. Grant only the required FCM sending permissions; never put the server credential in the APK/plugin/workflow artifacts.
5. Start the service as the restricted user. Check `http://127.0.0.1:8787/healthz` locally, then test the HTTPS endpoint and an authorized encrypted pairing/wakeup path separately. Do not log tokens, payloads or service-account material.
6. For updates, stop the service, back up the private state directory securely, replace only the executable, retain credentials/state, restart, and repeat health checks. Roll back binaries only when storage/protocol compatibility has been established. Never treat `--version` as a health check.

macOS requires equivalent private ownership/modes and a supervised non-root process; no launchd/notarization claim is made. Windows uses native object-handle security descriptors, not ineffective Unix `chmod` bits: owners and every allowed ACE must be the process user, SYSTEM or built-in Administrators. Null/absent/empty DACLs, broad grants (including inherit-only grants), unsupported/conditional ACEs, reparse points and multiply-linked regular files are rejected. State directories must have protected DACLs; database/credential files may inherit only those trusted grants. Newly created database privacy is checked before any routing secrets are written. There is no automatic ACL weakening or repair.

For Windows, use NTFS and a dedicated restricted service identity. Provision the credential/state parent and state directory with inheritance disabled, owner set to that identity, and only identity/SYSTEM/Administrators FullControl allow rules with ContainerInherit,ObjectInherit. Do this before placing credentials in the directory. For example, in PowerShell **running as the intended relay identity**, on new empty operator-selected directories:

```powershell
$root = 'C:\ProgramData\Away'
$state = Join-Path $root 'state'
New-Item -ItemType Directory -Path $root, $state -ErrorAction Stop | Out-Null
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $root -AclObject $acl
Set-Acl -LiteralPath $state -AclObject $acl
```

A privileged operator may instead provision equivalent ACLs for the intended service SID; do not accidentally grant the deployer's unrelated identity. Transfer existing credentials through a protected channel without command-history literals, preserve their ACLs, and configure the same absolute-path environment inputs. The executable is a supervised console process, not a built-in Windows Service Control Manager service; choose an approved supervisor and local HTTPS proxy. Run the native smoke and Windows tests before claiming deployment verification.

The reusable native acceptance command consumes the extracted native executable:

```sh
python tools/release/smoke_relay.py --binary /absolute/path/to/extracted/away-relay
# Windows: --binary C:\path\to\extracted\away-relay.exe
```

It copies that binary to a disposable private directory, creates random desktop credentials, a synthetic nonfunctional ADC identity and an empty private database, checks actual HTTP health, and cleans up. Linux root CI drops the child to the existing `nobody` identity without creating users or changing service configuration. Windows provisions DACLs only on its disposable test directories. External HTTP(S)/metadata access is directed to an unavailable loopback proxy; no FCM request or device action is part of this test. POSIX shutdown must be graceful; Windows process termination is used for smoke cleanup. A health failure fails the release job rather than being converted to a metadata-only success.

## Android install, signing and upgrades

Install the signed `away-vX.Y.Z.apk` on Android 10/API 29 or newer with Google Play services/FCM available. No AAB or app-store publication is part of this contract. The app's relay endpoint comes from the validated pairing configuration, not a deployment address compiled into a portable APK. For self-hosting, register Android package `ru.eleven.ompaway` in the same Firebase project used by the relay, enable FCM, and supply that project's **Android client** `google-services.json` during the protected build. The APK contains necessary Firebase client identifiers, not an admin/service-account private key; client identifiers are not an authorization boundary. Review any Firebase API-key restrictions for Android package/signing certificate compatibility.

Production releases require one stable, protected signing identity. Record its SHA-256 certificate fingerprint separately and pin `AWAY_SIGNING_SHA256`; the build verifies the finished APK against it. Back up the key and passwords offline under access control. Generate a new key only when authorized and no compatible key exists; key generation is an operator responsibility, never an automatic CI fallback. Do not regenerate on retries. The release job does not expose key/passwords in arguments or artifacts.

An in-place update requires the same application ID, compatible signing identity and strictly increasing versionCode. Use the OS installer or `adb install -r` only on an explicitly authorized test device. Do **not** uninstall, clear storage, change the application ID, or erase pairing/state to make an upgrade test pass. Verify pairing, preferences, private identity, active/inactive invitation handling and voice behavior survive a release-to-release upgrade.

A prior debug-signed app cannot be upgraded in place by a newly generated release key. Android rejects that signature mismatch. Treat migration as a separate, explicit user operation: preserve the old installation until a compatible signing path is chosen, or obtain informed approval for uninstall/reinstall and re-pairing (which loses local app state). There is no claim that a new key preserves a debug installation. Never silently downgrade to debug signing when release secrets are absent.

## Plugin installation and updates

The source repository root has no `package.json`; `omp install <repository URL>` is **not** the release installation contract. The archive contains `plugin/package.json`, source and prompts, the pinned generated live SDK, both Python projects and lockfiles, `install.py`, and these instructions. It intentionally contains no venv, node_modules, runtime token, pairing state, server credentials or compiled plugin executable.

Read-only installer investigation found:

- Installed omp `install --help` accepts a local package path, npm spec or marketplace ref; it does not promise monorepo subdirectory discovery or Python provisioning.
- The actual CLI routes local paths to `PluginManager.link`. That method requires `package.json`, symlinks the source directory into the plugin tree, and updates its runtime config. It does not install Bun or Python dependencies.
- `--scope=project` is ignored for local links (marketplace-only scope). It is **not isolation**.
- Use a retained archive directory and provision the helpers first. The actual Windows isolated installer and doctor checks passed; other desktop platforms remain unverified.

Prerequisites: stock **omp 19.1.0**, Bun **1.4.4**, uv **0.9.5**, Python **3.12.8** (uv may provision it), HTTPS access to the pinned dependency registries. The plugin's live SDK is coupled to omp 19.1.0; a later installed omp is not automatically compatible. Desktop media requires wheel/native-library availability for aiortc 1.14.0 / PyAV 16.0.1 on the machine. Windows amd64 installation and helper imports were verified. Linux amd64 and macOS amd64/arm64 remain candidate desktop installations. ARMv7 and Windows arm64 plugin/media support is excluded until dependency wheels and native runtime are verified. Do not confuse relay target coverage with desktop media coverage.

Extract the verified ZIP into a permanent versioned directory, then run:

```sh
python /absolute/path/to/omp-away-v1.0.5/install.py --omp /absolute/path/to/omp-19.1.0
```

The installer runs frozen Bun production installation, `uv sync --locked --no-dev --python 3.12.8` for tunnel and media, the actual `omp install /absolute/path/to/archive/plugin`, isolated Python helper imports and `omp plugin doctor`. Calls never provision dependencies dynamically.

Before starting omp, configure `OMP_AWAY_TUNNEL_PYTHON` to the absolute `plugin/tunnel/.venv/bin/python` (Windows: `.venv/Scripts/python.exe`). The media helper is located automatically at `plugin/media/.venv`. Configure `OMP_AWAY_URL` with your HTTPS relay origin, `OMP_AWAY_TOKEN_FILE` with the protected desktop credential path, and `OMP_AWAY_STATE_DIR` with the existing private state directory. Keep all of these outside the distribution. Do not display the values in shared logs. Complete the normal encrypted pairing flow.

For a **clean isolated acceptance install**, use a fresh retained archive extraction and a nonexistent test home; pass the exact pinned omp binary:

```sh
python /absolute/path/to/fresh-archive/install.py \
  --omp /absolute/path/to/omp-19.1.0 \
  --isolated-home /absolute/path/to/new-empty-acceptance-home
```

This isolates HOME/USERPROFILE, omp agent/config roots, XDG and Windows app-data roots; provider credentials and the operator's profile are not inherited. No model login or device action is required for installation. Record real installer/doctor output, then separately test loading and authorized runtime behavior. Do not run the clean test in the user's active profile. Remove only that disposable home/extraction after the orchestrator has collected results.

To update, stop affected omp sessions, verify/extract the new version to a new permanent directory, run its installer in the intended profile, and restart. Local linking updates the package pointer; never overwrite active source/venvs mid-call. Retain the separate private Away state and credentials so pairing survives. Delete the old extraction only after no process uses it and rollback is no longer needed.

## Build from the exact tag

Host-independent scripts are under `tools/release/`. Local prerequisites are Git, Go 1.26.0, Bun 1.4.4, uv 0.9.5, Python 3.12.8, Temurin Java 17.0.17+10 JDK, Gradle 8.14.3, Android platform 36 and build-tools 36.0.0. AGP 8.13.0 / Kotlin 2.2.20 / Google services plugin 4.4.4 remain pinned in the project. `ANDROID_HOME` must point to that SDK. Linux amd64 CI provisions these tools (including the JDK) with `bootstrap.py`; it requires only base Python 3, Git, CA roots and archive support. Tool archives are version-selected and checked against HTTPS upstream checksum metadata; this does not replace upstream supply-chain trust or a separately audited runner image.

Protected local build environment (set via your secret manager, not command-history literals):

| Variable | Meaning |
| --- | --- |
| `AWAY_FIREBASE_CONFIG` | Absolute protected Android client JSON file |
| `AWAY_KEYSTORE` | Absolute protected release keystore file |
| `AWAY_KEY_ALIAS` | Existing signing alias |
| `AWAY_STORE_PASSWORD`, `AWAY_KEY_PASSWORD` | Protected passwords |
| `AWAY_SIGNING_SHA256` | Expected certificate digest, 64 hexadecimal characters, no colons |

From a clean checkout of the existing release tag:

```sh
python -m unittest discover -s tools/release -p 'test_*.py'
python tools/release/release.py check-tools
python tools/release/release.py build --tag v1.0.5 --out /absolute/path/to/new-release-assets
python tools/release/release.py verify /absolute/path/to/new-release-assets
```

The output directory must not already exist. All tracked sources must match the tag; component staging uses tracked-file copies, not arbitrary working-directory contents. The plugin's SDK rebuild and Android client/signing setup happen only in temporary copies. Missing inputs fail before compilation. Go binaries omit build-machine paths; archives have deterministic entry timestamps/modes. Android/third-party build output may still vary across toolchain/OS runs: **different bytes on rerun fail publication rather than silently replacing assets**. Keep the original complete set for recovery. If a rebuilt set differs, investigate or release a new increasing tag.

## Forgejo/GitHub workflow configuration

The same `.github/workflows/release.yml` has tag and manual dispatch paths. Forgejo discovers that directory when `.forgejo/workflows` is absent; do not add a shadow workflow directory. No third-party checkout/setup/upload Actions are used, so there is no implicit `github.com` source checkout. Explicit host/repository must match the triggering event before authenticated Git fetch. No repository contents are mirrored elsewhere.

Configure variables **only on the intended authorized repository**:

| Variable | Forgejo example | GitHub example (only if separately authorized) |
| --- | --- | --- |
| `AWAY_RELEASE_HOST` | `forgejo` | `github` |
| `AWAY_SERVER_URL` | `https://forge.example.org` | `https://github.com` |
| `AWAY_API_URL` | `https://forge.example.org/api/v1` | `https://api.github.com` |
| `AWAY_UPLOAD_ORIGIN` | `https://forge.example.org` | `https://uploads.github.com` |
| `AWAY_REPOSITORY` | `team/away` | `authorized-owner/authorized-repository` |
| `AWAY_RUNNER` | optional; defaults `ubuntu-latest` | optional; defaults `ubuntu-latest` |

For GitHub Enterprise, server/upload origin are the explicit enterprise origin and API is `<origin>/api/v3`; validate its upload API path before live use. Origin URLs must be HTTPS without credentials, paths (except the API prefix), query or fragment. Subpath-hosted Forgejo deployments and off-origin Forgejo attachment stores are intentionally rejected until their authorization/redirect behavior is explicitly supported.

CI secrets: `AWAY_FIREBASE_CONFIG_B64`, `AWAY_KEYSTORE_B64` (strict base64 of protected file bytes), `AWAY_KEY_ALIAS`, `AWAY_STORE_PASSWORD`, `AWAY_KEY_PASSWORD`, `AWAY_SIGNING_SHA256`, `AWAY_CHECKOUT_USER`, `AWAY_CHECKOUT_TOKEN`, `AWAY_RELEASE_TOKEN`. No relay ADC/service-account secret is needed in the release workflow. Signing files are created 0600 in a temporary directory and removed on success/failure. Passwords are environment inputs, not command arguments. Normal logs must not enable shell tracing, Gradle debug logs or secret dumps. Pin the certificate outside the keystore so an accidental different key fails closed.

Protect release tags and restrict manual dispatch and secret access to trusted maintainers. Use disposable trusted runners: build scripts and dependency install hooks execute tagged code. GitHub should apply environment/tag approval protections appropriate to its deployment; Forgejo protection capabilities differ and must be enforced on the actual instance rather than assumed compatible. No PR/fork trigger is present. A non-admin dedicated Forgejo identity should have access only to this repository, with a repository-selected `read:repository` checkout token and repository-selected `write:repository` release token. GitHub needs repository-selected Contents read/write as appropriate; workflow-file modifications can require separate Workflows write authorization on some release API paths—grant only if the explicitly authorized target requires it. Never grant admin, package publication or unrelated repositories.

The implementation's live-host authorization is limited to orchestrator-only validation in the designated private Forgejo repository. **No GitHub target is authorized or live-validated.** Identical source compatibility is a design goal, not an executed acceptance result. Forgejo's `github.*` context compatibility, runner labels, secrets/vars, manual-dispatch inputs, concurrency and environment-file behavior must be checked on the actual server. The default runner is Linux amd64; metadata checks do not claim other native OS tests.

## Publication, drafts and recovery

Set the same five host variables above plus `AWAY_RELEASE_TOKEN` through protected environment configuration. No CLI default chooses a host/repository. Local commands:

```sh
# Create/resume a draft; upload missing assets and verify every remote byte.
python tools/release/publish.py /absolute/path/to/release-assets
# Finalize only after the entire expected set has been verified remotely.
python tools/release/publish.py /absolute/path/to/release-assets --finalize
```

The tag workflow finalizes; manual dispatch defaults to `draft` and accepts `finalize`. The existing tag is fetched exactly; no tag creation/push is done by build scripts. Publication binds release metadata to the source commit and manifest digest. It lists releases (including drafts), rejects duplicate releases/assets, verifies actual bytes of existing assets, uploads only missing names to a draft, re-downloads/hashes the complete set, and only then clears `draft`. Published releases are immutable no-ops only if every expected asset and binding matches. A published partial release, foreign asset, changed metadata, changed content, concurrent race or failed API call fails closed. No delete/overwrite/force option exists.

Forgejo uses `/api/v1/repos/{owner}/{repo}/releases`, multipart `attachment` uploads to `/releases/{id}/assets`, same-origin attachment downloads and PATCH finalization. Forgejo v15's asset listing is **unpaginated**. Listed attachments may use `/owner/repo/releases/download/<tag>/<name>`, while individual attachment metadata returns `/attachments/<uuid>`. The publisher correlates ID/UUID/name/size/type, validates both URLs against the configured HTTPS origin and exact attachment identity, then downloads using the validated individual metadata. External attachments, credentials, query/fragment variants, encoded traversal and redirects are rejected. GitHub retains paginated asset listing, binary uploads to the explicitly configured upload origin, and authenticated asset API downloads. Authorization is never forwarded across redirects. The sole download exception is GitHub's fixed `release-assets.githubusercontent.com` HTTPS CDN: signed redirects are followed **without** the bearer token. Forgejo off-origin object storage is not silently trusted.

Primary-source attachment contract: Forgejo tag `v15.0.11` resolves to commit `753f7edc775a97e66cd13d410404d5edc99b6b04`; see [attachment URL generation](https://codeberg.org/forgejo/forgejo/src/commit/753f7edc775a97e66cd13d410404d5edc99b6b04/models/repo/attachment.go), [API serialization](https://codeberg.org/forgejo/forgejo/src/commit/753f7edc775a97e66cd13d410404d5edc99b6b04/services/convert/attachment.go), and [release-scoped identity checks/unpaginated listing](https://codeberg.org/forgejo/forgejo/src/commit/753f7edc775a97e66cd13d410404d5edc99b6b04/routers/api/v1/repo/release_attachment.go). These source findings are not a claim that live publication passed.

On interruption, the draft remains unpublished; rerun with the **original complete local asset directory**. A full workflow rerun rebuilds and therefore may correctly fail if any bytes changed. Preserve outputs in the operator's protected storage before an ephemeral runner is destroyed; the workflow does not claim a cross-host artifact-storage service. If original bytes are unavailable and a rebuild differs, retain/quarantine the draft for diagnosis and choose a new increasing tag after explicit operator approval; never overwrite it. CI concurrency serializes the same tag when supported; server-side uniqueness errors also fail safely instead of guessing which upload won. Concurrent external publishers are unsupported and must be operationally excluded.

## Required orchestrator acceptance

Record commands, source commit, tool versions and platform/device evidence without private identifiers. Run the portable tests above; Go tests and all target builds; native non-root startup/health where authorized runners exist; plugin clean isolated install/doctor and load; Android unit/instrumentation/lint/build as available; signed APK clean install and **release-to-release** in-place upgrade on an explicitly authorized device; package/config/key leakage review; private Forgejo tag-trigger and draft-recovery verification. A test that is blocked or unrun is not a pass. GitHub live validation remains blocked until a specific authorized repository exists.

References: [Forgejo Actions compatibility](https://forgejo.org/docs/latest/user/actions/github-actions/), [Forgejo API usage](https://forgejo.org/docs/latest/user/api/usage/), [Forgejo token scopes](https://forgejo.org/docs/latest/user/authentication/token-scope/), [GitHub releases API](https://docs.github.com/en/rest/releases/releases), [bbolt platform matrix](https://github.com/etcd-io/bbolt/blob/v1.5.0/.github/workflows/cross-arch-test.yaml).
