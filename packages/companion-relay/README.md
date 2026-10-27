# LoliCode companion control service

Node.js 24 service for account-scoped discovery, encrypted enrollment, bounded
WebRTC signaling and an opt-in `text-v1` fallback. Production defaults still reject
legacy task `packet` and all push forwarding. Native direct channels remain
available; two approved account endpoints may negotiate a separately encrypted,
strictly bounded text/control channel when direct connectivity is unavailable.
There is no TURN, media/file relay or public legacy switch. STUN discovery and
relay readiness do not prove an actual direct connection.

Enrollment contracts: [account v2](../../docs/architecture/companion-account-v2.md)
and [native direct v1](../../docs/architecture/companion-direct-v1.md). The additive
text capability is specified below; clients without it retain their direct-only
wire behavior. This service cannot
decrypt enrollment or SDP, execute tasks, approve tools or observe native channel
readiness. Endpoints retain all task permission, AEAD and replay checks.

## Local development

```powershell
cd packages/companion-relay
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
$env:LOLICODE_COMPANION_ALLOW_INSECURE_LOCAL = 'true'
npm start
```

Internal endpoints: `http://127.0.0.1:18789/v2` and
`ws://127.0.0.1:18789/companion`. Cleartext requires the explicit development flag
and an actual loopback peer. Production requires HTTPS/WSS via the supplied
loopback proxy. Browser Origin/cookie headers are rejected. Credentials never
belong in URLs. Runtime dependency `ws` is pinned to 8.22.0 with lockfile integrity.

Tests use injected forum responses, real loopback HTTP/WS sockets, temporary state
and a controlled clock. They cover isolated identities, approval rollback,
revocation, restart, expiry, rate limits and rejected task relay. They do not
contact real accounts or establish real phone NAT traversal.

## Account access and storage

Only `/v2/session` accepts the forum credential wrapper. Verification uses the
fixed `https://lolicode.com/api/users/<id>` self-profile endpoint, `Token` auth,
no cookies/redirects, 15-second timeout and a 128 KiB response bound. Exact ID and
private CurrentUserSerializer fields are mandatory: public-profile HTTP 200 is
refused. No caller supplies an identity-provider URL. Provider bodies, credentials
and private profile fields are never logged, persisted or returned.

Companion tickets are opaque random values lasting 15 minutes, hashed only in
memory, scoped to companion APIs and limited to two/device. Third renewal evicts
the oldest ticket and closes its sockets. Tickets do not survive restart. A forum
credential cannot call other companion APIs and is not an encryption key.

UUID, account, P-256 SPKI, fingerprint and device role form an immutable identity.
A verified renewal may change its display name. Logout revokes tickets, requests
and bound rooms, closes sockets, and retains a bounded identity tombstone against
silent key replacement. In-flight verification cannot resurrect a logged-out
device. An explicit later login using the same identity can issue fresh tickets.
`online` means authenticated presence within 120 seconds, not task readiness;
presence is saved at most once/minute.

One atomic `rooms.json` v2 file stores devices, requests and account room bindings.
V1 state migrates on the next write. Approval consumes a pending request and
creates a room in the same replacement; a failed write restores memory. Only
role-token hashes and opaque enrollment envelopes are accepted. Room keys and
unwrapped pairing never reach this API. Tombstones prevent room-ID reuse, and
startup rejects corrupt bindings. Run one process per private state directory.

## Authenticated transports and limits

Account hello requires the scoped ticket and exact bound account/device/role plus
role token. A legacy QR hello cannot claim an account room. Every operation and
outbound delivery checks ticket validity. Expiry/logout/revocation closes the WS;
clients must close their direct channel on control closure or peer offline.

Account-room `signal` envelopes forward, with server-authenticated `from`.
Limits are 16 KiB wire including `from`, 32 frames and 256 KiB/room/minute across
both directions. A shared process budget also caps all rooms together at 512
frames and 2 MiB/minute. Successful account HTTP metadata shares an 8 MiB/minute
output budget; mutations reserve space before committing. Fixed error responses,
connection controls and protocol overhead remain additional traffic. Metrics
report rejected budgets separately from text forwarding.
Reconnect does not reset room or process budgets or replay IDs. Missing peers
produce `peer_offline`: offers are never queued or replayed. Endpoints validate
signaling AAD, negotiation binding, timestamps and SDP. The opaque service cannot
inspect encrypted contents. Task packet and push controls return `direct_only`.

`createCompanionRelay().metrics()` provides aggregate HTTP payload, WS control,
signal, text and legacy-task-forwarding byte counters plus queue/connection counts.
It exposes no identities or payloads. Counts exclude HTTP/TLS/WS framing and ping
overhead; use host/firewall counters for billed traffic. `taskForwardedBytes` is
legacy packet plus text egress, while `relayPacketBytesOut` remains legacy-only.
No inferred P2P status is emitted.

Retained v1 task relay/queue and FCM code run only in explicit code-level tests
using `allowLegacyDataRelay:true`; the production entry point exposes no HTTP or
environment setting for it. Account rooms reject tasks even in that test mode.
Firebase is unconfigured; no production background push availability is claimed.

## Bounded account text fallback (`text-v1`)

The existing account hello may add exactly `capabilities:["text-v1"]`. The server
returns `{type:"ready",v:1,textRelay:true}` to a capable client (false if the durable
budget is unavailable). Existing clients still receive the unchanged ready frame.
When both bound roles are online and capable, both receive
`{type:"peer",online:true,textRelay:true,textEpoch:"<32 lowercase hex>"}`. A missing
or incompatible peer has `textRelay:false` and no epoch. Every disconnect, policy
failure or revocation invalidates the epoch; reconnect creates a fresh random one.
The epoch belongs to this live pair, not to an account-wide or offline session.

Only `{type:"text",v:1,id,epoch,nonce,ciphertext}` is accepted. `id` is a UUID,
`nonce` is canonical unpadded base64url for 12 bytes, and ciphertext is canonical
base64url including an AEAD tag. The server adds `from:"desktop"|"phone"`; a client
cannot supply `from` or other fields. Both device tickets, immutable room/device/
account/role bindings and role-token hashes remain mandatory. Every delivery
reauthorizes its destination ticket. Ciphertext IDs are deduplicated, stale
epochs rejected and text is never stored in an offline queue. A failed connection
does not automatically retry a task or refund already reserved budget.

Text endpoints must use a dedicated AEAD/AAD domain bound to room, role, current
epoch and packet ID, retain replay/time checks, and accept only fixed text/control
schemas after decryption. They must project structured deltas, approval/question
controls and short text previews. Media, attachments, file transfers, screenshots,
data-URL/base64 content, complete history snapshots and unrestricted tool output
are excluded by the client schemas. The server cannot distinguish text from
arbitrary encrypted bytes: it enforces identity, framing and byte quotas, not a
plaintext semantic guarantee. Do not tunnel task data through `signal` instead.

Text limits are 8192 serialized UTF-8 bytes per frame **including server-added
`from`**, a global egress token bucket of 8192 B/s with 16384 B burst, and a shared
account bucket of 2048 B/s with 8192 B burst. Both directions and every room/device
of that account consume the same account bucket. A destination may buffer at most
32768 text bytes, including the proposed frame. The service rejects a slow peer,
rate exhaustion or offline peer immediately; it does not accumulate a fair queue
or delayed task commands. Clients must pace/coalesce deltas and keep their own
bounded replay state. Reconnecting does not recreate account/process credit.

An additional **global 2 GiB per UTC month** hard ceiling applies to serialized
text egress. `text-budget.json` reserves up to 64 KiB durably before any frame can
be written. Atomic replacement, file sync and (on POSIX) directory sync precede
delivery. Unused reservation is conservatively lost on restart, never granted
twice. A backward clock does not reset the month; a later UTC month can open a new
quota. Corrupt/unreadable ledgers are preserved and disable text. Any reservation
write/sync failure disables text for the process before further delivery. Back up
this ledger with the other private state; never delete it to resolve an error.
Run one process per state directory, as for room state. No environment variable
can raise these ceilings; code-level `limits` overrides may only lower them.

`textBytesIn/Out`, `textsOut`, `textBudgetRejected`, `textRejected`, fixed-reason
`textDrops` and `textBudget.monthlyReservedBytes` distinguish actual socket-write
egress from conservative reservations. Counters contain no account IDs or payloads.
Explicit text errors include `text_rate_limited`, `text_monthly_quota_exhausted`,
`text_budget_unavailable`, `text_slow_peer`, `text_epoch_invalid` and
`text_not_negotiated`. They close this transport, not the user's account session;
clients must not interpret them as credential revocation or retry mutations.

These limits bound **text body egress**, not the entire host, website, signaling
or authentication traffic. Existing signal/HTTP limits above remain separate;
TLS/HTTP/WebSocket overhead and retransmission are not included. A continuously
saturated 8 KiB/s would otherwise exceed 19 GiB in 30 days, so the durable monthly
stop is essential. This package makes no unlimited bandwidth or successful P2P
claim. Aggregate counters plus host billing metrics are required for deployment.

Defaults: 256 accounts, 4096 immutable devices (16/account), 4096 requests
(64/account), 1000 room IDs including tombstones, 256 sockets (16/account), 8 KiB
HTTP bodies, 240 HTTP calls/minute/IP, 8 session attempts/minute/IP, 64 concurrent
HTTP requests, 8 concurrent forum calls and 2048 IP buckets. Rate limits precede
expensive key parsing and forum IO. Requests, tickets, replay IDs and ciphertext
memory remain bounded.

## Production review

Docker pins official Node 24.19.0 bookworm-slim by digest. Run uid/gid 1000 with a
read-only root, dropped capabilities and private state mount (0700, files 0600).
Back up `rooms.json` with `push-state.key` together; the latter protects retained
legacy push registrations. Never upload state or keys. Windows requires NTFS
ACLs because POSIX modes alone do not enforce access control there.

Nginx maps `/companion/v2/*` to `/v2/*`, `/companion/ws` to `/companion`, and
`/companion/health` to `/health`. Additive templates bound requests and disable
access logs. Forwarded HTTPS/IP assertions require an actual loopback peer.
Health exposes readiness, protocols, `directPreferredTextFallback` policy, text
budget availability, legacy compatibility state and push configuration only.

The initial installer refuses an existing container. Review [the update script](../../deploy/companion/update.py)
separately with pinned source archive, previous image ID/owner and nginx config
hashes. It preserves a private backup bundle and old container, and retains failed
state for inspection. V2 state cannot be handed to a v1 binary without restoring
its matching backup. Website routes and desktop update feeds are outside scope.

[STUN-only review](deploy/STUN-ONLY.md) supplies an isolated official coturn image
pinned by digest and bounded additive UDP firewall template. It is separate from
account HTTP; running this package does not deploy it.

Environment: `LOLICODE_COMPANION_HOST` (127.0.0.1), `LOLICODE_COMPANION_PORT`
(local 18789/container 13010), `LOLICODE_COMPANION_STATE_DIRECTORY`
(local data/container /var/lib/lolicode-companion), `LOLICODE_COMPANION_TRUST_PROXY`
(default true), development-only `LOLICODE_COMPANION_ALLOW_INSECURE_LOCAL`
(default false). No production task-relay flag exists.
