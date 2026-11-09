#!/usr/bin/env python3
"""Publish per-account Credit controls with an isolated schema and Nginx check."""
import argparse
import json
import re

import release_billing_health
import release_credit
import release_credit_refactor
from migrate import remote

PREVIOUS = 'credit-20261030T094000Z'
SOURCES = (*release_billing_health.SOURCES, *release_credit_refactor.EXTRA_SOURCES,
           'admin_accounts.py', 'test_admin_accounts.py')
TESTS = (*release_credit_refactor.TESTS, 'test_admin_accounts')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply'))
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'credit-\d{8}T\d{6}Z', args.release):
        parser.error('A fixed credit-YYYYMMDDTHHMMSSZ release identifier is required')
    payload = {'release': args.release, 'nginx': True}
    if args.action == 'prepare':
        origin = remote(args.host, r'''
owned()
manifest=json.loads((ROOT/'credit-releases'/payload['previous']/'manifest.json').read_text())
site=pathlib.Path('/etc/nginx/sites-available/lolicode-relay-admin.conf')
expected=(ROOT/'admin-nginx-http.conf').read_text()+'\n'+(ROOT/'admin-nginx-https.conf').read_text()
if site.is_symlink() or site.read_text()!=expected:
    raise RuntimeError('Relay Nginx has operator changes; preserve them')
emit({'baseline':{name:entry['after'] for name,entry in manifest['targets'].items()},
      'http':(ROOT/'admin-nginx-http.conf').read_text(),
      'nginx_before':hashlib.sha256(site.read_bytes()).hexdigest()})
''', {'previous': PREVIOUS})
        files = {
            name: {'content': (release_credit.HERE / name).read_text(encoding='utf8'),
                   'baseline': origin['baseline'].get(name)}
            for name in SOURCES
        }
        for name in (*release_credit.PORTAL, 'admin-accounts.js'):
            for prefix in ('public/', 'portal-source/'):
                relative = prefix + name
                files[relative] = {
                    'content': (release_credit.HERE / 'portal' / name).read_text(encoding='utf8'),
                    'baseline': origin['baseline'].get(relative),
                }
        # Preserve deployed paths and release baselines after the repository move.
        for name, source in (('LICENSE', 'litellm-LICENSE'), ('README.md', 'litellm.md')):
            relative = 'third_party/litellm/' + name
            files[relative] = {
                'content': (release_credit.REPO / 'third-party/notices' / source).read_text(encoding='utf8').replace('(litellm-LICENSE)', '(LICENSE)'),
                'baseline': origin['baseline'][relative],
            }
        files['nginx/relay.conf'] = {
            'content': origin['http'] + '\n' + (release_credit.HERE / 'admin-nginx-https.conf').read_text(encoding='utf8'),
            'baseline': origin['nginx_before'],
        }
        payload.update(files=files, tests=TESTS)
    result = remote(args.host,
                    release_credit.PREPARE if args.action == 'prepare' else release_credit.APPLY,
                    payload, timeout=600)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
