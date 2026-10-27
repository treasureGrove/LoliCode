# Companion account-v2 direct-only update

## Pending text fallback update (2026-10-27; not activated)

The records below describe the earlier direct-only deployment and remain its
rollback baseline. Current source adds account-only `text-v1`, while keeping
anonymous rooms, legacy task packets and push forwarding disabled. The target
health policy is now `directPreferredTextFallback`, with explicit public
`textLimits`: 8192-byte frames, at most 8192 text egress bytes/second globally,
2048/account and 2 GiB per UTC month. These are serialized text-body limits;
signaling, authentication and network overhead are accounted separately.

A future activation must build a new pinned source archive containing
`src/text-budget.mjs`, review fresh live image/config hashes, and retain
`text-budget.json` with private state. The updater preserves the highest durable
monthly reservation when rolling back; restoring an older room snapshot must
never refund text quota. Corrupt ledgers remain fail-closed. The updated updater
passed 26 isolated Linux FakeDocker tests, without accessing live private state
or changing Docker/Nginx. Desktop and Android transport tests are separate from
physical-phone cross-network acceptance, which is still pending. No new image,
public route, desktop release or mobile release has been activated by this work.

## Previous direct-only deployment (2026-10-26)

2026-10-26 delivery. Only the owned companion container and its two nginx
includes are updated. The website main file, model inference relay, desktop
stable feeds, STUN service and cloud firewall are outside this updater.

The deployed runtime source archive contains 20 public source files, 25,291 bytes:
`e787df55df3b57b2f3dfa260467d03c3472ef4a24fb5c7c3a19c04352c1870a1`.
Final updater SHA:
`66aec85e95c652def874e2ba97659a1107aee8eaf719df02e06a1c24c192b479`.
Final updater-test SHA:
`cc49a1727b2883a58540de361ca36137b52b3f1af268588a5ae130a249c6161f`.
Image: `lolicode-companion:account-v2-e787df55df3b57b2`;
actual image ID: `sha256:bd638c5c4fbd84e7fc9dee5589ae6777cd1155652dea1a61ffb24a9edd59351d`.

## Reviewed activation

The initial installer intentionally refuses an existing container. `update.py`
defaults to a read-only plan. It checks owner, previous image ID, exact private
mount and permissions, source archive and all three nginx hashes. Its lock
serializes this updater without changing unrelated Docker dependencies.

The following is the exact reviewed command for the original v1 baseline.
It is historical after successful activation: a repeat now correctly fails
the previous-image/config CAS. A future upgrade needs a new reviewed baseline.

```sh
stage=/opt/lolicode-companion/preflight-account-20261026
python3 -B "$stage/update.py" \
  --archive "$stage/companion-account-v2-source.tar.gz" \
  --sha256 e787df55df3b57b2f3dfa260467d03c3472ef4a24fb5c7c3a19c04352c1870a1 \
  --site-sha256 e401097065f05e3a4e9a6b180b33dec514966bd3526e5c68fa322c8fd27a5949 \
  --rates-sha256 2a0750aa5ee00e938670b04212621ba08591a8ef790697c1aa99c5ffb42dee8a \
  --locations-sha256 628a43b5f3eb040551dc427173882d0d3098d23fc5415ecef8a776014ddf9ac8 \
  --expected-image-id sha256:4715683e9e9a61347f8c2d95561f474089de4c7ba7f0addac247f1373bcfd94c \
  --activate
```

Build completes before stopping the service. From the first stop attempt onward,
failures inspect the exact owned baseline and recover it, including commands that
take effect before their CLI reports failure. State plus configuration form one
private atomic backup bundle. The old container remains stopped for rollback;
failed replacement containers and state remain available for inspection.
An old v1 binary must use its matching v1 backup, never the new v2 state.
Concurrent changes and foreign containers are preserved and require re-planning.
No state, key, Authorization, enrollment envelope or provider body is printed.

Nginx reload is asynchronous. The updater checks existing health and the newly
added devices route with at most 10 GET-only attempts. It always requires exact
v2/direct-only health and exact unauthenticated 401 JSON; it never retries
mutations or relaxes the body check. Safe diagnostics contain endpoint, status,
content type and allowlisted error code, never raw HTML/response bodies.

## Observed verification

- Node: 50/50 tests, including real local HTTP/WS with injected forum responses,
  account/device/role isolation, immutable keys, expiry/logout/restart, approval
  rollback, shared bandwidth budgets and rejected task forwarding.
- Updater: 16/16 on Linux using real temporary uid/gid/modes plus FakeDocker fault
  injection. Covers stop/rename after-effect errors, foreign replacement,
  failed nginx/public routes, matching-state restoration and strict 401 bodies.
- Frozen nginx includes passed the target host's isolated `nginx -t` before switch.
- The first deployment rolled back after a public readiness failure. The final
  updater observed the new devices route first returning 404 HTML, then passing
  exact 401 on attempt 2. This confirmed the worker handoff window; the original
  failed source, container, state and script receipts were retained.
- The final independent public negative smoke passed without real credentials:
  v2/direct-only health, unauthenticated devices 401, anonymous legacy rejection,
  and rejection of an unauthenticated packet. It creates no registered devices or
  rooms. Local tests assert `taskForwardedBytes:0`; these public negative checks
  are not a real-account or native NAT-traversal test.

Run only the new smoke after a deployment:

```sh
node packages/companion-relay/test/public-direct-smoke.mjs
```

Do not use the old v1 public relay smoke as evidence of the direct-only release.
Default account and legacy traffic cannot forward task packets or push; legacy
compatibility remains an explicit code-level test option only.

Post-update configuration hashes:

- Website unchanged: `e401097065f05e3a4e9a6b180b33dec514966bd3526e5c68fa322c8fd27a5949`.
- Rate include: `6bcd7b59f5b1285b82be14bd7512ee891653981c35747352f8985fece9436931`.
- Route include: `85b4a0d9ca7707b987ade30bf4b39fe552f6f2f8fa1619e01198d990f71ce39e`.

Sanitized receipts are in local `tmp/release-20261026/companion-server-account-v2/`.
Private matching backups remain on the server with mode 0700 and files 0600;
they are never part of a source commit or desktop release artifact.

STUN is a separate [bounded container/firewall deployment](../../packages/companion-relay/deploy/STUN-ONLY.md).
Its isolated Linux Binding/no-TURN checks passed. At activation time, external
UDP probes had not reached the host; cloud UDP-3478 ingress was being addressed
separately. This document does not claim real phone Wi-Fi/mobile NAT traversal.
