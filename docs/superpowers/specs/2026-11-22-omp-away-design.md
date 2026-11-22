# omp-away: answer a built-in Ask by voice

The Android phone is another way to answer the original desktop Ask, not another agent, form, or authority to execute work. The desktop is authoritative for request validity, the conversation, and Codex login. The public relay delivers opaque invites and forwards encrypted streams. No phone traffic to OpenAI, public omp relay, SIP, or Tailscale.

## Three owners

- `plugin/`: desktop extension, loopback Collab responder, authenticated endpoint, voice/media bridge. Use a control room already aimed at the plugin's loopback relay **before** Ask opens; never repurpose a user's existing remote room. The control link never leaves the desktop. Accept only confirmed form answers, never prompt/abort/agent control. The first valid desktop or guest submission wins inside built-in Ask. No core edits, private UI instance manipulation, or replacement forms.
- `relay/`: the public HTTPS/WSS endpoint `away.example.invalid`, provisioned on the authorized host. Holds installation routing, FCM tokens, and opaque pending identifiers. Never receives decrypted questions, decisions or audio. Generic FCM notification; no field data, phone bearer token or key in a notification or URL log.
- `android/`: paired native Android app with a pending inbox, generic invite, audio input/output, Not now, hangup and answer flows. Only the relay and Google services are network dependencies of the handset. End-to-end identity verification with matching emoji codes and persistent pins; changed keys block calls until verified again.

## Decisions

Normal routing shows Ask on the desktop. Optional escalation has an independent configurable timeout and can be disabled. `/away` rings immediately. Neither an escalation nor FCM delivery resolves anything. Require native `ask.timeout=0` for the keep-pending contract. Declining suppresses future ringing for that request. Hanging up or a dropped connection leaves it pending; a cancelled desktop request disappears from the inbox.

The coding session supplies the question, rationale, recommendation and context using a tool-free side turn. The voice surface uses desktop-authenticated `gpt-live-1-codex`. A request for clarification gets a tool-free side turn against current session context, not a normal live delegation. Treat voice speech and transcripts as untrusted input. Bind confirmation to a specific pending request, canonical field values and a specific readback. A clarification, ambiguous yes, modified proposal, interruption, stale call or duplicate answer must not submit.

## Acceptance

Real FCM invite and two-way Codex Live audio on `Pixel 10 Pro XL (99)` (display name, not an API level). Clarify before answering; read back, confirm by voice and observe exactly one correct structured result on desktop. Exercise desktop wins, immediate call, escalation toggle/delay, Not now, hangup, replay, pin mismatch and no-default-submit. Inspect relay capture and Android egress. No acceptance based solely on mocks; stop at 128 failed E2E attempts. Keep secrets out of Git, docs and chat. No README; coordination docs at root, component procedures in the owning repo. Reference repos stay read-only.