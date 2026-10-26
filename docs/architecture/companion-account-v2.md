# Companion account enrollment v2

Implementation contract, 2026-10-26. This adds account-scoped discovery and encrypted
enrollment to the existing v1 task protocol. It does not change background tool
permissions or claim a Signal ratchet. All times are Unix milliseconds. JSON uses
camelCase. Binary fields use canonical unpadded base64url; hashes use lowercase hex.

## HTTP and authentication

Public base `https://lolicode.com/companion/v2`, relay-internal base `/v2`.
Public WebSocket remains `wss://lolicode.com/companion/ws` (internal `/companion`).
Production clients require HTTPS/WSS, no credentials in URLs and no redirects.
Explicit loopback HTTP/WS is allowed only in test/development configuration.
All responses are JSON; errors are `{error:{code,message}}` with fixed messages.
No cookies, CORS browser access, logging of Authorization or request bodies.

`POST /session`, Authorization `Bearer lc1.<accountId>.<forumToken>`, body
`{deviceId,deviceName,kind:"desktop"|"phone",publicKey}`. Validate the credential
against the fixed trusted forum self-profile endpoint, including private
CurrentUserSerializer fields and exact account ID, not a public-profile 200.
Never accept a caller-provided identity-provider URL. Device ID is a UUID and
publicKey is P-256 SPKI DER. Identity (account, ID, role, key) cannot be overwritten.
Name is a bounded display string. Return
`{v:2,accountId,deviceToken,expiresAt,device}`. The opaque random deviceToken lasts
15 minutes, is stored hashed on the service, and authorizes only companion APIs.
The forum credential is neither a device ticket nor an encryption key.

Subsequent requests use Authorization `Bearer <deviceToken>`. Requesting a new
session with the same registered identity renews access. Maximum two live tickets
per device; old tickets expire. Devices and room bindings persist, tickets do not.
Live sockets close at ticket expiry and revocation. Clients renew before expiry
and reconnect without replaying mutations. They close local runtime on logout or
account change even if remote revocation cannot be delivered.

Device DTO: `{deviceId,deviceName,kind,publicKey,fingerprint,online,lastSeenAt}`.
Fingerprint is SHA-256 of decoded SPKI DER. Only same-account devices are returned.
`online` means an authenticated presence within 120 seconds, not task readiness.

- `GET /devices` -> `{devices:[Device]}`.
- `POST /presence`, body `{}` -> `{ok:true}`; at most once per 60 seconds when idle.
- `DELETE /device` -> `{ok:true}`; revokes own tickets, requests and bound rooms.
- `POST /requests`, phone only, body `{desktopDeviceId}` -> `EnrollmentRequest`.
  Reuse a pending, unexpired request for that device pair rather than generating
  unbounded requests. A request expires after five minutes.
- `GET /requests` -> `{requests:[EnrollmentRequest]}` for this device only.
- `GET /requests/<requestId>` -> `EnrollmentRequest` for either bound endpoint.
- `POST /requests/<requestId>/approve`, bound desktop only, body
  `{roomId,desktopTokenHash,phoneTokenHash,envelope:{nonce,ciphertext}}` ->
  `EnrollmentRequest`. Atomically consumes pending request and creates its room.
  roomId is 32 lowercase hex; role token hashes are SHA-256 of UTF-8 64-hex tokens.
  Reject reused room IDs, equal role hashes, expired/consumed/foreign requests.
- `POST /requests/<requestId>/reject`, bound desktop only, `{}` ->
  `EnrollmentRequest` (status rejected).
- `POST /rooms/<roomId>/revoke`, either bound endpoint only, `{}` -> `{ok:true}`.

EnrollmentRequest: `{requestId,accountId,challenge,desktop:Device,phone:Device,
createdAt,expiresAt,status:"pending"|"approved"|"rejected",roomId?,envelope?}`.
challenge is 32 random bytes. Approved envelope is returned only to its endpoints.
Poll pending requests every 3 seconds while enrollment UI is visible; idle desktop
discovery uses 30-second polling. Do not repeatedly fetch task snapshots at idle.
Bound body sizes, identities, devices/account, pending requests/account, requests/IP,
tickets/device and sockets/account. Rate limiting must precede expensive auth.

## Device keys and enrollment envelope

Each installation keeps a separate stable device UUID and P-256 key pair for
each account. Desktop private PKCS8 stays in an account-scoped OS credential
vault entry (`account:<canonical accountId>`); switching A to B and back must
restore A's original identity, without reusing A's identity for B. Clear the
in-memory identity cache on the account fence. Preserve the former unscoped
`installation` entry; copy it only when saved room bindings uniquely prove the
same account, device UUID and public-key fingerprint. Never overwrite a damaged
scoped identity or silently assign an unknown legacy identity to a new account.
Android PKCS8 is sealed by AndroidKeyStore AES; API 26 support
must not rely on API 31 AndroidKeyStore ECDH. The public SPKI is safe to display.
After enrollment, retain and verify the peer fingerprint; never silently replace
an existing device key. Initial identity directory trust is the authenticated
service plus explicit desktop approval of the requesting device.

Use P-256 ECDH, producing the 32-byte fixed-width unsigned X shared secret.
Use HKDF-SHA256 (32-byte output), salt = decoded challenge. The info is UTF-8 of
these exact ASCII fields joined by LF, with no trailing LF:

```
lolicode-companion-account/2
<accountId>
<requestId>
<challenge>
<desktop.deviceId>
<desktop.fingerprint>
<phone.deviceId>
<phone.fingerprint>
```

AAD is that same transcript plus `\nenrollment`. Generate a random 12-byte nonce.
AES-256-GCM ciphertext includes the 16-byte tag. Plaintext JSON is
`{v:2,accountId,requestId,desktopDeviceId,phoneDeviceId,desktopKeyFingerprint,
phoneKeyFingerprint,pairing}`. pairing is the existing v1 phone pairing DTO
`{v:1,relayUrl,roomId,phoneToken,key,hostName,expiresAt}` with fresh 32-byte AES key
and fresh 64-hex role tokens, generated on desktop. Never send the desktop token
or unwrapped pairing key to the account service. The receiver checks every
binding, expiry, configured relay origin/path, key length and token format before
persisting anything. Tampered envelopes fail closed.

## Room transport and account fences

Account room hello adds `deviceToken` to v1 hello, omits phoneToken registration,
and must match the room account, bound device ID and role as well as role token.
The service pre-creates rooms from approval hashes. It must not allow v1 room
creation to claim or bypass account room authorization. Legacy QR rooms keep their
separate v1 policy and are not assigned to an account implicitly.

The native desktop owns account polling, registration, ticket renewal and room
connections. Renderer receives only public identity/status/request DTOs; no forum
credentials, private keys, device tickets, room keys or role tokens for v2.
Local desktop approval is mandatory before the phone can dispatch tasks. Existing
single-operation tool approval, request deduplication, room session ownership,
authenticated packet timestamps/AAD and replay checks remain mandatory.

Native discovery and heartbeats continue while the window is hidden or minimized
to the tray; renderer visibility changes polling cadence only. A directory online
indicator means a recent authenticated device heartbeat (120-second service TTL),
not an open direct task channel. Phone UI keeps directory presence and direct
connectivity separate. A failed or stale directory refresh becomes unknown rather
than retaining an old green online indicator or inferring offline from a failed
direct connection. Only a verified direct channel enables task actions.

## Direct transport direction

Discovery/signaling is separate from task transport so P2P can replace relaying
without changing account isolation, device keys, enrollment or task permissions.
The current product policy is direct-only, as specified in
[companion direct transport](companion-direct-v1.md). No task relay fallback is
permitted. Expose the actual selected direct route only after a native channel
opens. ICE/STUN negotiation alone is not proof of direct data transport. Failure
must be visible. Signaling and connection housekeeping still use some service
traffic. Any WebRTC signaling must
be carried inside the already authenticated encrypted device channel; never accept
arbitrary offers from account IDs alone or run a device as a third-party relay.
