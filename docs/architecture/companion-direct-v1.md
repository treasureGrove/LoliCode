# Companion direct-only transport v1

2026-10-26: the user explicitly rejects task-data relay. This supersedes the
fallback discussion in account-v2. Account enrollment remains v2; task packet
crypto and task permissions remain v1. No TURN, no task packet over WebSocket,
no implicit fallback. Legacy QR enrollment is no longer exposed by the new UI.

## Native connection

Desktop uses native webrtc-rs `webrtc = =0.17.2` (callback API); Android uses native
Maven Central `io.github.webrtc-sdk:android:150.7871.04`. Neither depends on a
visible browser/WebView. Only SCTP data channels, no audio/video capture.
Both configure only `stun:lolicode.com:3478`, no TURN URLs or credentials. Tests
may explicitly use an empty ICE-server list for local native host-candidate tests.
The self-hosted discovery helper must run STUN-only, with TURN allocations disabled.

After account room hello, wait for both peers online. Desktop is always offerer.
Create one reliable ordered channel, label `lolicode.tasks.v1`, protocol
`lolicode-companion/1`. Default in-band SCTP channel negotiation, no fixed stream ID.
Gather candidates for at most 10 seconds, then send the full local SDP once
(non-trickle). The phone validates offer then generates a full answer identically.
Reject SDP >10 KiB, relay candidates, audio/video media sections, missing DTLS
SHA-256 fingerprint or missing application data channel. Limit total connection
setup to 40 seconds; report failure and allow explicit retry. No task may be sent
before the data channel opens and the normal authenticated host status succeeds.

Android may report an initial COMPLETE before its network callbacks produce any
candidates. Never latch or publish an empty answer. Keep the 10-second gathering
deadline even in that state. After an empty COMPLETE, a late candidate must wait
for a fresh COMPLETE notification or that existing deadline; a stale COMPLETE
getter must not publish only the first host candidate and omit a later srflx.
At the deadline, publish the current nonempty SDP once or close on no usable
candidate. Local-description readiness, cancellation and closing fence all late
callbacks. This does not extend the 40-second connection limit.

## Encrypted signaling

WebSocket hello is account-v2 hello with scoped deviceToken. The only encrypted
forwarding frame permitted is `{type:"signal",v:1,id,nonce,ciphertext}`; server
adds `from:"desktop"|"phone"`. `id` is a fresh UUID, nonce is random 12 bytes,
ciphertext is AES-256-GCM with the room key, tag appended, canonical base64url.
AAD UTF-8 is `lolicode-companion-signaling/1|<roomId>|<senderRole>|<id>`.
Strictly validate opposite role, five-minute sentAt window, deduplicate IDs.

Plaintext is only one of:

- `{type:"direct.offer",negotiationId,sdp,sentAt}` from desktop.
- `{type:"direct.answer",negotiationId,sdp,sentAt}` from phone.

negotiationId is a fresh UUID generated for this WebSocket connection. Phone
answers once per offer ID; desktop accepts only the answer matching its active
negotiation ID, once. Never log SDP, candidates, tickets or decrypted signaling.
Signaling is bounded: <=16 KiB wire frame, <=32 frames / 256 KiB per room/minute.
Do not enqueue task data or replay old offers after reconnect. The server rejects
`packet` and push forwarding in direct-only deployment, including legacy rooms.
Plain ready/peer/error and WebSocket ping/pong remain connection controls.

## Direct task data and lifecycle

DataChannel messages are UTF-8 JSON of the existing encrypted packet, with
`from` explicitly supplied by sender; no plaintext tasks. Desktop sends
`from:"desktop"`; phone sends `from:"phone"`. Existing v1 packet AAD, timestamp,
replay, room ownership, receipt and permission checks are unchanged. Accept only
packet frames <=64 KiB; send buffer is bounded to 512 KiB. Close on malformed
data, overflow or authentication failure. Do not replay mutations on reconnect.

The authenticated WebSocket remains open as a low-volume revocation/expiry
control channel. Its close, device/account revocation, logout, ticket expiry,
peer offline or ICE/data-channel failure closes the native direct connection.
Renew ticket and reconnect through the normal account flow, taking one fresh
snapshot; never route task traffic through the control connection.

Public status uses `transportPolicy:"directOnly"`, `directAvailable:true` for
build capability. Pair transport is `"direct"` only while the actual native
channel is open, otherwise null; connection state is `connecting|direct|offline`.
Capability alone is not proof of a working direct connection. UI must display
"直连不可用，请切换网络后重试" on setup failure; no relay option is offered.

## Acceptance

Prove a real native DataChannel round trip, encrypted packet tamper/role/replay
rejection and a payload whose bytes are absent from server forwarding counters.
Prove signaling tamper/foreign negotiation/revoked ticket closure and no task
WebSocket fallback when the remote peer is absent or UDP is blocked. Distinguish
local host-candidate proof from real phone Wi-Fi/mobile-network NAT traversal.
The final user requirement is operation across different primary networks, not
merely two devices behind one router. Same-router tests are diagnostics only.
Before final acceptance, test authenticated task dispatch, approval, questions
and stopping over two independent upstream networks and verify no task relay.
