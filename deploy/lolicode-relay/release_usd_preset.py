#!/usr/bin/env python3
"""Publish the administrator-approved USD/Credit default without changing prices."""
import argparse
import json
import re

import release_billing_health
import release_credit
from migrate import remote

HERE = release_credit.HERE
PREVIOUS = 'credit-20261030T074000Z'


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
        files = {name: {'content': (HERE / name).read_text(encoding='utf8'), 'baseline': baseline[name]}
                 for name in release_billing_health.SOURCES}
        for name in release_credit.PORTAL:
            for prefix in ('public/', 'portal-source/'):
                files[prefix + name] = {'content': (HERE / 'portal' / name).read_text(encoding='utf8'),
                                        'baseline': baseline[prefix + name]}
        payload.update(files=files, tests=release_billing_health.TESTS)
    result = remote(args.host, release_credit.PREPARE if args.action == 'prepare' else release_credit.APPLY,
                    payload, timeout=600)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
