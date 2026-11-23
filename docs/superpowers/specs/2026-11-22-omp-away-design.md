# omp-away: answer a built-in Ask by voice

The Android phone is another way to answer the original desktop Ask, not another agent, form, or authority to execute work. The desktop is authoritative for request validity, the conversation, and Codex login. The public relay delivers opaque invites and forwards encrypted streams. No phone traffic to OpenAI, public omp relay, SIP, or Tailscale.

## Three owners

- `plugin/`: desktop extension, loopback Collab responder, authenticated endpoint, voice/media bridge. Use a control room already aimed at the plugin's loopback relay **before** Ask opens; never repurpose a user's existing remote room. The control link never leaves the desktop. Accept only confirmed form answers, never prompt/abort/agent control. The first valid desktop or guest submission wins inside built-in Ask. No core edits, private UI instance manipulation, or replacement forms.
- `relay/`: the public HTTPS/WSS endpoint `away.example.com`, provisioned on the authorized host. Holds installation routing, FCM tokens, and opaque pending identifiers. Never receives decrypted questions, decisions or audio. Generic FCM notification; no field data, phone bearer token or key in a notification or URL log.
- `android/`: paired native Android app with a pending inbox, generic invite, audio input/output, Not now, hangup and answer flows. Only the relay and Google services are network dependencies of the handset. End-to-end identity verification with matching emoji codes and persistent pins; changed keys block calls until verified again.

## Decisions

Normal routing shows Ask on the desktop. Optional escalation has an independent configurable timeout and can be disabled. `/away` rings immediately. Neither an escalation nor FCM delivery resolves anything. Require native `ask.timeout=0` for the keep-pending contract. Declining suppresses future ringing for that request. Hanging up or a dropped connection leaves it pending; a cancelled desktop request disappears from the inbox.

The coding session supplies question, rationale and context through a tool-free side turn. The desktop-authenticated `gpt-live-1-codex` call can clarify the pending decision via a distinct tool-free consultation, never steer the coding session. A person may propose an answer in their own words. Codex reads the actual proposed field values back naturally and asks whether to submit them. Check the meaning against the complete validated draft, not the wording of the whole assistant utterance. Real handset playout must finish first; a separate, subsequent, unambiguous spoken affirmative (a plain “yes” is sufficient) submits that same pending Ask at most once. There is no required preamble, recited phrase or spoken challenge. An early yes, interruption, correction, changed value, stale request or missing playback proof must not submit. Pairing and internal request/playback identifiers are protocol machinery, never spoken call steps.

## Acceptance

Real FCM invite and two-way Codex Live audio on `approved test emulator` (display name, not an API level). Clarify before answering; read back, confirm by voice and observe exactly one correct structured result on desktop. Exercise desktop wins, immediate call, escalation toggle/delay, Not now, hangup, replay, pin mismatch and no-default-submit. Inspect relay capture and Android egress. No acceptance based solely on mocks; stop at 128 failed E2E attempts. Keep secrets out of Git, docs and chat. No README; coordination docs at root, component procedures in the owning repo. Reference repos stay read-only.