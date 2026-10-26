# LoliCode companion control service

Node.js 24 service for account-scoped discovery, encrypted enrollment and bounded
WebRTC signaling. Production defaults reject task `packet` and all push forwarding
on account and legacy rooms. Task data belongs on the authenticated native direct
DataChannel. There is no TURN or task relay fallback, public legacy switch, or
claim that successful STUN discovery proves an actual direct connection.

Contracts: [account v2](../../docs/architecture/companion-account-v2.md) and
[direct-only v1](../../docs/architecture/companion-direct-v1.md). This service cannot
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

## Direct-only transport and limits

Account hello requires the scoped ticket and exact bound account/device/role plus
role token. A legacy QR hello cannot claim an account room. Every operation and
outbound delivery checks ticket validity. Expiry/logout/revocation closes the WS;
clients must close their direct channel on control closure or peer offline.

Only account-room `signal` envelopes forward, with server-authenticated `from`.
Limits are 16 KiB wire including `from`, 32 frames and 256 KiB/room/minute across
both directions. A shared process budget also caps all rooms together at 512
frames and 2 MiB/minute. Successful account HTTP metadata shares an 8 MiB/minute
output budget; mutations reserve space before committing. Fixed error responses,
connection controls and protocol overhead remain additional traffic. Metrics
report rejected budgets and `taskForwardedBytes:0` in the default direct-only mode.
Reconnect does not reset room or process budgets or replay IDs. Missing peers
produce `peer_offline`: offers are never queued or replayed. Endpoints validate
signaling AAD, negotiation binding, timestamps and SDP. The opaque service cannot
inspect encrypted contents. Task packet and push controls return `direct_only`.

`createCompanionRelay().metrics()` provides aggregate HTTP payload, WS control,
signal and legacy-task-forwarding byte counters plus queue/connection counts.
It exposes no identities or payloads. Counts exclude HTTP/TLS/WS framing and ping
overhead; use host/firewall counters for billed traffic. Default task-forwarded
bytes stay zero. No inferred P2P status is emitted.

Retained v1 task relay/queue and FCM code run only in explicit code-level tests
using `allowLegacyDataRelay:true`; the production entry point exposes no HTTP or
environment setting for it. Account rooms reject tasks even in that test mode.
Firebase is unconfigured; no production background push availability is claimed.

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
Health exposes readiness, protocols, direct-only policy, compatibility state and
push configuration only.

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
