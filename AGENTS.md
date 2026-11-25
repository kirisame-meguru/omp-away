# Confidentiality and publication

- Never commit or publish private infrastructure domains or subdomains, internal hostnames, real deployment addresses, non-example IP addresses, personal filesystem paths, private account names or email addresses, device identifiers, pairing payloads, credentials, tokens, private keys, signing material, production logs, transcripts, or captured session data.
- This rule applies to source, examples, documentation, tests, generated files, binaries, filenames, Git commit messages and author/committer metadata, tags, and remote configuration copied into the repository. Deleting a value from the latest version does not remove it from history.
- Use reserved examples such as `example.com`, `example.invalid`, documentation address ranges, and generic relative paths. Obtain private configuration at runtime through environment variables or protected local files; never embed actual values in templates or operator scripts.
- Public project identities or URLs may be included only when the owner has expressly approved them. Do not treat a reachable service or an existing private remote as permission to disclose its address.
- Keep secret-scan findings redacted and outside the repository. Never log or paste a credential to prove it exists. Report its category and affected location instead.
- Audit all intended publication refs and their history before a public release. Preserve third-party attribution and licenses; ask before replacing legitimate attribution or rewriting history.
- Publication and synchronization are currently paused. Do not make repositories public, trigger mirror synchronization, push to GitHub, force-push, delete remote refs, or rewrite history without renewed explicit authorization.
- Prefer Forgejo's native push-mirror settings over custom synchronization scripts. A prepared mirror must have push-triggered synchronization disabled and interval `0`; verify that saving it cannot trigger an initial sync before creating it.
- Other agents may be editing the component repositories. Coordinate ownership before editing shared files or Git refs. Never absorb another agent's in-progress changes into an unrelated commit.

## Private operational context

- Before deployment, pairing, live-device verification, or shared-runtime changes, read the checkout's ignored `LOCAL_OPERATIONS.md`.
- Keep production endpoints, machine-local paths, device details, and operational state in that private file or protected runtime configuration, never in tracked documentation. Do not force-add the file or copy its contents into commits, public issues, or release artifacts.
- If the private file is absent in a fresh checkout, inspect the existing protected `OMP_AWAY_*` bindings and coordinate with the active operator. Do not guess an endpoint, replace pairing keys, or infer loaded runtime compatibility from the source revision alone.
