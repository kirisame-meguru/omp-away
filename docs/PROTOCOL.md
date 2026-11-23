# Away/1 wire contract

Deployment serves one operator/desktop route. Outer HTTPS API uses a 256-bit desktop bearer provisioned on both relay and desktop; `Authorization: Bearer ...` always, no tokens in URLs. The phone bearer is separate. The public relay is not an authority for inner TLS. Reject redirects for authenticated requests. JSON request and response names below are case sensitive; success without body is 204.

| Operation | Input → output |
|---|---|
| `POST /v1/enrollments` desktop | `{}` → `{ticket}` fresh random base64url token, one-time, ten-minute expiry |
| `POST /v1/enroll` unauthenticated | `{ticket}` → `{deviceId,token}` new random route + phone bearer; expired or used ticket rejected |
| `PUT /v1/token` phone | `{fcmToken}` → 204; replace for this device only |
| `POST /v1/invites` desktop | Exactly `{deviceId,requestId}` → 204; FCM HTTP v1 high-priority data-only message containing only `requestId`, short TTL, duplicate invitation coalesced. No question, session, options or event type |
| `POST /v1/invalidations` desktop | Exactly `{deviceId,requestId}` → 204; same opaque FCM data as invitations, with a separate bounded deduplication namespace so an invitation cannot suppress retirement |
| `GET /v1/control` desktop WebSocket | Relay text frame `{"type":"connect","deviceId":"…","connectionId":"…"}` per waiting phone; reject a second desktop connection |
| `GET /v1/phone` phone WebSocket | Phone initiates tunnel; after control message, relay matches desktop opening `/v1/tunnels/{connectionId}` with desktop bearer. Raw binary TLS bytes in both directions; queue bounded or backpressure until desktop connects; no other frame protocol on these sockets |
| `GET /healthz` | 200 no secrets |

Pair QR/clipboard payload: JSON `{v:1,url:"https://relay.example.org",ticket,desktopPin,nonce,secret}`. `desktopPin` is unpadded base64url SHA256(DER SPKI). `nonce` and `secret` are independent 32-byte random values encoded unpadded base64url. Inner TLS 1.3: phone verifies desktop pin even on first contact; desktop verifies the phone proved possession of its presented client key. First enrollment can use a self-signed client certificate but **requires** successful TLS CertificateVerify, fresh secret and both emoji confirmations before any private data. After enrollment both directions require pinned keys. A changed key never automatically replaces a pin. Emoji digest = SHA256(ASCII `omp-away/1` + 0x00 + raw desktopPin digest + raw phonePin digest + raw nonce); encode first 6 bytes as twelve hex nibbles mapped to the ordered Unicode list `🐶 🐱 🦊 🐻 🐼 🐸 🐵 🐯 🦁 🐷 🐨 🐰 🐙 🐧 🐳 🐢`. Compare 48 bits, not a single emoji. Public route tokens never authorize private requests.

The pairing `url` is the explicit trusted HTTPS relay origin, not a compiled handset endpoint. Reject credentials, paths other than `/`, query strings and fragments. Android seals the validated origin with its existing route/token/pins. Legacy sealed routes without an origin require the user to enter the same trusted origin; this migration preserves the existing pairing keys, pins and token rather than silently changing hosts or re-enrolling.

Inside TLS frame: 1 byte kind (1=UTF-8 JSON, 2=signed-16 little-endian 24 kHz mono PCM, exactly 960 bytes), 4-byte unsigned big-endian length, payload. The entire encoded JSON frame is limited to 65,536 bytes. Reject unknown kinds, oversize frames, duplicate object keys or unexpected direction. Pairing only: phone `{type:"pair",secret,nonce}`, desktop `{type:"verify",emoji}` as a check only (Android computes locally and compares), phone `{type:"verify",accept:true}`, desktop `{type:"paired"}` only after local operator approval.

## Encrypted inbox and read-only questions

The phone sends `{type:"list",details:true}` to opt this authenticated connection into question/proposal metadata. Legacy `{type:"list"}` and explicit `details:false` are valid, summary-only requests; non-boolean details is invalid. A new connection starts without opt-in. Older desktops may close the connection on the extra list field rather than sending an error: the handset can retry once on a fresh connection in legacy summary-only mode. An unsolicited inbox is not evidence that details negotiation succeeded. Missing question frames or unknown display versions always mean an explicit “summary only / details unavailable” view, never inferred choices.

The desktop first sends a complete authoritative `{type:"inbox",items:[{requestId,project,question,createdAt,session?}]}` snapshot, then one `{type:"question",requestId,display}` for each live authorized request whose display fits. `createdAt` is nonnegative epoch milliseconds (safe JSON integer); project and optional session are at most 128 UTF-16 code units, question is at most 256. The excerpt comes from the actual parsed question, never an async routing title. Session is the real host session display name when available and safe; absent/older-host/path-like names use the project fallback. Session IDs, full paths and capability URLs are not fallback names. Bounded excerpts do not split surrogate pairs.

```typescript
type QuestionDisplay = {
  v: 1;
  context: string;
  fields: Array<{
    id: string;
    label: string;
    kind: "single" | "multi" | "text";
    required: boolean;
    description?: string;
    other?: boolean;
    inputType?: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string; disabled: boolean }>;
  }>;
};
```

Version 1 permits 1–32 fields, at most 256 options per choice field, and at most 49,152 UTF-8 bytes for the complete encoded display. Context, label, description, inputType, placeholder and each option label are limited to 8,192 UTF-16 code units; NUL and malformed Unicode are invalid. Field IDs are positional `f1`, `f2`, etc.; option IDs restart at `o1` within each field. Duplicate labels retain distinct IDs. Unknown properties, native `name`/`value` fields, repeated IDs, malformed types and wrong request associations are rejected, not coerced. Text fields have no options/Other; choice fields have an options array and no inputType/placeholder.

The projection uses the original `tagForm` parser result also used by native/voice validation, for both native Ask and async sources. Descriptions retain section/fieldset grouping, native field context and text constraints; context retains form text. Disabled options are included and marked unavailable; their native values are not sent. `other:true` means the native choice supports a free-text Other answer, not an invented option. Input defaults, hidden fields, native submission identities, HTML, image sources and capability tokens are not part of the display. Render every label as plain text, never HTML. Read-only options cannot submit or confirm anything.

No display is partially truncated to fit. Unsupported/oversized display metadata is omitted while the request remains in the authoritative summary. Forms that cannot be safely tagged/validated remain desktop-only. Visual availability does not inherit voice's tighter limits: description 16,384 bytes, opening 8,192 bytes and at most 32 voice fields. Exceeding those limits preserves the complete bounded visual form but rejects a join with `voice-unavailable`.

An inbox is never truncated either. If the entire authorized snapshot, including the shared broker's merged sessions, exceeds 65,536 bytes, send `inbox-too-large`, not a partial or empty authoritative list. The handset must retain pending-sync status, invalidate actionable cached metadata and await a successful full reconciliation. Each valid inbox invalidates old detail until matching fresh metadata arrives; reject orphan detail and clear request details/proposals on retirement, disconnect or request switching. The shared broker authorizes details by the request's owning session and device audience; after every merged snapshot it replays still-owned details in `(createdAt,requestId)` order so another session's update cannot erase unrelated current detail.

On connection/list reconciliation the shared broker waits for every currently attached owner's inbox before emitting the merged authoritative snapshot. Old detail caches are invalidated for that reconciliation. A departing owner removes only its own barrier entry; remaining owners still must reply. A five-second timeout emits `inbox-unavailable`, never a partial list or retirement of a silent owner's requests. The handset stays unverified/pending-sync and may retry list. This timeout is not a cancellation authority.

Optional `{type:"proposal",requestId,text}` is sent only to the opted-in active caller and summarizes an actual validated `DecisionReply.draft`, never assistant speech or transcript-derived guesses. Text is at most 8,192 UTF-16 code units; empty text clears it. The broker replays a still-current proposal after merged inbox/detail reconciliation, and clears it on call end, disconnect or retirement. A proposal is not a submitted answer.

## Calls and authoritative retirement

The phone sends `{type:"join",requestId,captions?}`, `{type:"silence"|"hangup",requestId}` or legacy `{type:"played",requestId,mark}`. Captions are opt-in booleans; desktop `{type:"transcript",requestId,role:"user"|"assistant",text,final}` is limited to the active caller and 8,192 characters. Desktop also sends `{type:"joined"|"ended",requestId}`, `{type:"mark",requestId,mark}` or `{type:"error",code}`. One joined call per tunnel. Never receive submitted form values or untrusted tool calls from the phone. Desktop alone holds, validates and confirms native answers; read-only details introduce no submit endpoint. Disconnect/hang-up release media, not the Ask.

Before deleting request capabilities, the desktop captures their birth-authorized device audience and invokes `SecureDesktop.invalidate(deviceId,requestId)` (helper operation `invalidate`). This covers native answer/cancel/room loss, async withdrawal/source loss, accepted completion and graceful host close. The shared broker retains only opaque audience pairs across phone disconnects and wakes them on an unexpected owning-session exit. Devices enrolled after a request's birth do not acquire its metadata or retirement wakeups. Retirement HTTP operations use the desktop bearer, prohibit redirects and send exactly the same opaque route pair as invitations; question/session/options never enter HTTP/FCM payloads or logs.

The helper accepts retirement for delivery only after reserving an entry in a 4,096-route bounded retry set. Failed delivery retries after one second, then every 30 seconds; the shared broker stays alive while accepted retirements remain, including after the owning desktop exits. Only opaque `(deviceId,requestId)` pairs are retained. A successful helper reply may therefore acknowledge queued delivery rather than an already delivered push. Backlog exhaustion is reported, not silently acknowledged. This retry state is process-local; killing the gateway or rebooting still requires the phone's next encrypted reconciliation. No retry creates submission authority.

Every accepted FCM wakeup, including duplicates, is a synchronization hint, never proof of cancellation or permission to answer. The phone revalidates over pinned encrypted TLS in an OS-permitted background job, closes withdrawn calls, cancels exactly the retired notification and preserves unrelated requests. Persisted closed/seen/silenced state prevents delayed invitations from re-ringing or resurrecting a retired request. Offline devices, failed delivery and Android background restrictions make removal eventual at the next permitted delivery/reconnect, not instantaneous. Keep generic pending-sync UI until authoritative reconciliation; never ring from stale cache.

Desktop helper boundary: Python runs the handset tunnel TLS and desktop aiortc in separate helpers; Bun orchestrates streaming, signaling, and requests. Subprocesses exchange length-bounded data and control; no protocol-over-stdout logs. Child processes never get Codex secrets. Helpers may communicate arbitrary binary only over framed stdio. Keep subordinate credential handling off the public relay. Publish neither capability links nor raw session transcripts.

Upgrade the source plugin and installed Python helper together, then close all Away-enabled desktop sessions so the shared gateway restarts with the updated validators. Phone/desktop metadata negotiation is backward-compatible; an already-running older local helper is not upgraded by replacing source files alone.
