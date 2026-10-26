# STUN-only review plan

Prepared, not deployed. The target is the existing `lolicode` host for
`stun:lolicode.com:3478`. Do not install this service on the unrelated `tools`
release/mail host. Read-only inspection on 2026-10-26 found Ubuntu 24.04,
no coturn binary, no listener on 3478/5349, inactive ufw and existing Docker
iptables/nftables tables. Preserve all website, mail, SSH and Docker rules.

The three templates are `coturn-stun-only.conf`, `stun-only.compose.yml` and
`stun-only.nft`. The isolated `lolicode-stun` container uses only UDP 3478, disables
TURN allocations with `stun-only`, TCP relay, TCP clients, TLS/DTLS, RFC5780 alternate
ports and the admin CLI. No TURN users, credentials or allocation port range
are configured. Do not install a system-wide package or start a host TURN daemon.
Official `coturn/coturn:4.18.0-r0` registry manifest checked on 2026-10-26:
`sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3`;
Linux amd64 child: `sha256:59af4221a2c45c1195a1a4a865542b3ea744be1dd8e228d11bde87c6631081cf`.
The Compose file pins that digest, labels only its own container, runs as an
unprivileged user and bounds CPU, memory, threads, descriptors and temporary
storage. Version 4.18 uses false values for opt-in DTLS/CLI/RFC5780 instead of
removed legacy flags.

Linux preflight found the official executable has exactly
`cap_net_bind_service=ep` (permitted mask 0x400). With all capabilities dropped,
exec itself fails EPERM. The isolated profile therefore adds only
NET_BIND_SERVICE to the otherwise empty bounding set, retaining no-new-privileges;
it grants no NET_ADMIN or NET_RAW. Coturn also refuses simultaneous
no-udp-relay/no-tcp-relay; `stun-only` plus no-tcp-relay is the supported
configuration, with independent firewall rejection of all Allocate requests.
`alt-listening-port=3478` keeps Coturn's alternate sockets on the same port.

Linux preflight on the target host passed in an isolated `network:none`
container: actual Binding Success with XOR-MAPPED-ADDRESS (64-byte response),
no TURN allocation, only UDP 3478 listeners, nonroot read-only execution with
the bounded capability/resources above, and zero stdout/stderr log bytes.
`nft --check --file` also passed without applying rules. No public listener or
provider firewall was changed by this preflight.

`lolicode-stun.service` owns foreground Compose startup and has Requires/After
on Docker and `lolicode-stun-firewall.service`. The firewall starts first and
stops last, operating only the dedicated `inet lolicode_stun` table after
checking root-owned manifest/owner receipts. It refuses to remove that table
while the STUN container is running. Compose restart is `no`: Docker cannot
start the container ahead of its firewall on reboot. No global Docker dependency
is changed. `stun-firewall.py status` reports aggregate rule counters without
printing dynamic client address sets.

The firewall table is additive. It accepts only RFC5389 Binding Requests with
UDP lengths 28–1024 bytes, a bounded 4096-entry source table per IP family,
5 requests/second/source (burst 10) and 100/second total (burst 100).
Binding responses are at most 256 UDP bytes, 100/second, and 16 KiB/second
(burst 32 KiB). These are actual firewall limits. Coturn's TURN `max-bps` or
allocation quotas do not establish a STUN bandwidth limit. Existing later
firewall drops still apply; review host/cloud ingress policy separately.
No forwarding/allocation ports are opened, and no other host ruleset is flushed.

Before activation, review `nft --check --file stun-only.nft`, Compose validation
and the pinned image's actual coturn options on an isolated local container.
The Linux checks above establish parser/runtime compatibility; external UDP
reachability and rate behavior still require activation testing. Back up only this task's
existing files/rules privately, stage both the firewall and service config,
and preserve an exact rollback. Review listening addresses and the domain's
A/AAAA records. Do not change broad provider firewall rules. If an external UDP
probe fails, identify host/cloud filtering and report the specific UDP-3478
provider setting needed for user review.

After activation, prove an actual Binding Success and XOR-MAPPED-ADDRESS from
an external network, a rejected TURN Allocate, absent TCP/TLS/alternate-port
listeners, bounded flood behavior and aggregate nft counters. The service
does not log client addresses or requests. A STUN response proves discovery
only. Native DataChannel tests and real phone Wi-Fi/mobile NAT tests must prove
direct connectivity separately; blocked UDP must fail without any TURN or
WebSocket task fallback. Incoming discarded Internet traffic may still be
charged by the hosting provider; these caps bound service work and responses.

References: [coturn 4.18 configuration](https://github.com/coturn/coturn/blob/4.18.0/examples/etc/turnserver.conf),
[official Docker release](https://github.com/coturn/coturn/releases/tag/docker/4.18.0-r0),
[nftables dynamic rate limiters](https://wiki.nftables.org/wiki-nftables/index.php/Meters).
