#!/usr/bin/env python3
"""Validate and publish the Credit-only quota refactor without repricing history."""
import argparse
import json
import re

import release_billing_health
import release_credit
from migrate import remote

PREVIOUS = 'credit-20261030T091551Z'
EXTRA_SOURCES = ('quota_snapshot.py', 'test_quota_snapshot.py', 'CREDIT_ARCHITECTURE.md')
TESTS = (*release_billing_health.TESTS, 'test_quota_snapshot')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply'))
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'credit-\d{8}T\d{6}Z', args.release):
        parser.error('A fixed credit-YYYYMMDDTHHMMSSZ release identifier is required')
    payload = {'release': args.release}
    if args.action == 'prepare':
        baseline = remote(args.host, r'''
owned()
manifest=json.loads((ROOT/'credit-releases'/payload['previous']/'manifest.json').read_text())
emit({name:entry['after'] for name,entry in manifest['targets'].items()})
''', {'previous': PREVIOUS})
        files = {
            name: {'content': (release_credit.HERE / name).read_text(encoding='utf8'),
                   'baseline': baseline.get(name)}
            for name in (*release_billing_health.SOURCES, *EXTRA_SOURCES)
        }
        for name in release_credit.PORTAL:
            for prefix in ('public/', 'portal-source/'):
                target = prefix + name
                files[target] = {
                    'content': (release_credit.HERE / 'portal' / name).read_text(encoding='utf8'),
                    'baseline': baseline[target],
                }
        # Preserve deployed paths and release baselines after the repository move.
        for name, source in (('LICENSE', 'litellm-LICENSE'), ('README.md', 'litellm.md')):
            relative = 'third_party/litellm/' + name
            files[relative] = {
                'content': (release_credit.REPO / 'third-party/notices' / source).read_text(encoding='utf8').replace('(litellm-LICENSE)', '(LICENSE)'),
                'baseline': baseline.get(relative),
            }
        payload.update(files=files, tests=TESTS)
    result = remote(args.host,
                    release_credit.PREPARE if args.action == 'prepare' else release_credit.APPLY,
                    payload, timeout=600)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
