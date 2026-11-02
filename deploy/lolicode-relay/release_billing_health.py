#!/usr/bin/env python3
"""Publish billing and hourly probe support against the reviewed Credit release."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import re

import release_credit
from migrate import remote

HERE = release_credit.HERE
PREVIOUS = 'credit-20261030T075500Z'
SOURCES = (*release_credit.SOURCES, 'bootstrap.py', 'billing_meter.py', 'channel_health.py',
           'test_billing_meter.py', 'test_billing_bridge.py', 'test_channel_health.py', 'test_system_probes.py',
           'lolicode-relay-health.service', 'lolicode-relay-health.timer', 'admin-nginx-https.conf')
TESTS = (*release_credit.TESTS, 'test_billing_meter', 'test_billing_bridge', 'test_channel_health', 'test_system_probes')
UNITS = ('lolicode-relay-health.service', 'lolicode-relay-health.timer')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply'))
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'credit-\d{8}T\d{6}Z', args.release):
        parser.error('A fixed credit-YYYYMMDDTHHMMSSZ release identifier is required')
    payload = {'release': args.release, 'health_units': True, 'nginx': True}
    if args.action == 'prepare':
        origin = remote(args.host, r'''
owned()
manifest=json.loads((ROOT/'credit-releases'/payload['previous']/'manifest.json').read_text())
site=pathlib.Path('/etc/nginx/sites-available/lolicode-relay-admin.conf')
expected=(ROOT/'admin-nginx-http.conf').read_text()+'\n'+(ROOT/'admin-nginx-https.conf').read_text()
if site.is_symlink() or site.read_text()!=expected:
    raise RuntimeError('Relay Nginx has operator changes; preserve them')
anchor='location = /admin-api/public-settings {\n        client_max_body_size 64k;'
if expected.count(anchor)!=1:
    raise RuntimeError('Unexpected public settings location')
emit({'baseline':{name:entry['after'] for name,entry in manifest['targets'].items()},
      'nginx':site.read_text().replace(anchor,anchor.replace('64k','256k')),
      'nginx_before':hashlib.sha256(site.read_bytes()).hexdigest()})
''', {'previous': PREVIOUS})
        files = {}
        for name in SOURCES:
            default = release_credit.baseline(name)
            files[name] = {'content': (HERE / name).read_text(encoding='utf8'),
                           'baseline': origin['baseline'].get(name, default)}
        for name in release_credit.PORTAL:
            entry = {'content': (HERE / 'portal' / name).read_text(encoding='utf8')}
            for prefix in ('public/', 'portal-source/'):
                files[prefix + name] = {**entry, 'baseline': origin['baseline'][prefix + name]}
        for name in UNITS:
            files['systemd/' + name] = {'content': (HERE / name).read_text(encoding='utf8'), 'baseline': None}
        files['nginx/relay.conf'] = {'content': origin['nginx'], 'baseline': origin['nginx_before']}
        payload.update(files=files, tests=TESTS)
    result = remote(args.host, release_credit.PREPARE if args.action == 'prepare' else release_credit.APPLY,
                    payload, timeout=600)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
