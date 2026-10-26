# Android companion protocol v1

Implementation contract, 2026-10-23. Package: `art.treasuregrove.lolicode.mobile`.
Android uses Kotlin/Jetpack Compose; desktop uses its existing Rust native Agent.
The experimental OpenCode platform host and model relay are not this transport.

## Pairing and transport

Each pairing has its own room and key. JSON QR data (also accepted as pasted JSON):

`{"v":1,"relayUrl":"wss://host/companion","roomId":"32 lowercase hex characters","phoneToken":"64 lowercase hex characters","key":"base64url of 32 bytes, no padding","hostName":"Computer","expiresAt":1792713600000}`

Desktop separately stores a random 64-hex `desktopToken`, never in the QR. Pairing
expires after five minutes for new enrollment. Desktop must explicitly approve
the requesting phone before any task command is accepted. Revocation closes the
room and invalidates its credentials. Initial implementation supports one phone
per room; two phones require separate pairings.

Client websocket greeting:

`{"type":"hello","v":1,"role":"desktop|phone","roomId":"...","token":"role-specific token","phoneToken":"desktop registration only"}`

Relay replies `{"type":"ready","v":1}`. Relay sends peer availability as
`{"type":"peer","online":true}`. It authenticates roles, persists room credential
hashes, bounds messages/rooms/queues and only forwards opaque encrypted packets.
WSS is mandatory except explicit local development mode. Never relax the old
platform client's loopback-only policy to implement this protocol.

Encrypted packet JSON:

`{"type":"packet","v":1,"id":"UUID","nonce":"base64url, 12 random bytes","ciphertext":"base64url AES-256-GCM ciphertext followed by 16-byte tag"}`

AAD UTF-8 is `lolicode-companion/1|<roomId>|<sender role>|<packet id>`.
Relay supplies `from: "desktop"|"phone"` on forwarding; decryption must validate
the opposite expected role. Plaintext includes `sentAt` (Unix milliseconds).
Reject packets outside a five-minute clock window, repeated packet IDs, malformed
fields and oversized payloads. Generate each nonce with a cryptographic RNG.

Pairing plaintext: `{type:"pair.request",deviceId,deviceName,sentAt}`.
Desktop local approval replies `{type:"pair.approved",deviceId,hostName,sentAt}`;
rejection replies `{type:"pair.rejected",sentAt}`. Phone credentials are stored
using Android Keystore-backed encryption, not clear preferences.

## Requests

Phone sends `{type:"request",requestId,method,params,sentAt}`. Desktop replies
`{type:"response",requestId,ok:true,result,sentAt}` or
`{type:"response",requestId,ok:false,error:{code,message},sentAt}`.
Each approved room owns its created sessions. Request ID reuse with a different
payload is rejected; mutations are not blindly replayed after reconnection.

Allowed methods and params:

- `status`: `{}` → `{hostName,protocol:1,quietMode:true}`.
- `projects.list`: `{}` → array of `{path,name}` already opened on desktop.
- `models.list`: `{projectPath}` → native Agent catalog (background bind only).
- `sessions.list`: `{}` → this room's sessions only.
- `session.create`: `{projectPath,modelId,title?}` → native `AgentSession`.
- `session.get`: `{sessionId}` → native `AgentSnapshot`.
- `message.send`: `{sessionId,text}` → `{accepted:true,requestId}`.
- `run.cancel`: `{sessionId}` → native cancellation receipt.
- `permission.reply`: `{sessionId,permissionId,decision:"once"|"reject"}`.
- `question.reply`: `{sessionId,questionId,answers}` (native answers schema).

Phone-origin sessions always use `permissionMode:"ask"`, explicit project
binding and a fail-closed background tool policy. No foreground project selection,
window activation, raw IPC dispatch, unattended remembered approvals or implicit
desktop tool launch is exposed. The first safe tool policy can disable shell and
interactive hosted tools until isolated execution is implemented; report that
limitation rather than silently weakening the quiet-mode guarantee.

Desktop monitors its sessions in Rust independent of frontend pages. It emits
`{type:"event",eventId,kind,sessionId,requestId?,sentAt}` for
`approval_required`, `question_required`, `task_completed`, `task_failed`.
Persist event deduplication and request/session ownership. Snapshots remain the
source of truth after reconnect; stale approval notifications never authorize a
new operation.

## System push

Authenticated phone sends relay control message
`{type:"push.register",provider:"fcm",token:"registration token"}`.
Relay answers `{type:"push.status",configured:boolean,registered:boolean}`.
Desktop sends `{type:"push.notice",eventId,kind,sessionId}`; only desktop role
may send this. All identifiers are bounded and no prompt, command, file or model
credential is included. FCM provider credentials live only on the relay server.
Notice payload contains roomId/eventId/kind/sessionId, generic Chinese title and
body, Android notification channel `lolicode_tasks`, high priority and bounded TTL.
Provider acceptance is not a delivered-to-device receipt.

Android requests notification permission where required, uses private lockscreen
visibility and opens the app after device unlock to retrieve and validate the
current snapshot. No approve action is exposed on the lockscreen. Missing FCM
configuration must show `unconfigured`; a local websocket notification is not
evidence that background push works. Both target phones currently have Google
services. Real Firebase config and real-device lockscreen verification are still
required. Public deployment and APK download are separate verified delivery steps.
