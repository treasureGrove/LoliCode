#!/usr/bin/env python3
"""Root-only account allowance inspection and disabling; never prints credentials."""
import argparse
import json
from bridge import ROOT, Ledger


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('list', 'disable', 'enable'))
    parser.add_argument('--user-id')
    args = parser.parse_args()
    ledger = Ledger(ROOT / 'bridge-state/bridge.sqlite3')
    if args.action != 'list':
        if not args.user_id or not args.user_id.isdigit() or args.user_id.startswith('0'):
            parser.error('A positive forum --user-id is required')
        with ledger.connect() as db:
            result = db.execute('UPDATE accounts SET disabled=? WHERE forum_id=?',
                                (int(args.action == 'disable'), args.user_id))
            if result.rowcount != 1:
                raise RuntimeError('No mapped account with that forum ID')
        print(json.dumps({'user_id': args.user_id, 'disabled': args.action == 'disable'}))
        return
    policy = json.loads((ROOT / 'bridge-policy.json').read_text())
    with ledger.connect() as db:
        accounts = [dict(row) for row in db.execute(
            'SELECT forum_id,username,display_name,gateway_id,disabled FROM accounts ORDER BY cast(forum_id AS INTEGER)')]
    print(json.dumps([{**row, 'quota': ledger.summary(row['forum_id'], policy)} for row in accounts],
                     indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
