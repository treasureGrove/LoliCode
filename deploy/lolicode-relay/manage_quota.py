#!/usr/bin/env python3
"""Root-only account allowance inspection and disabling; never prints credentials."""
import argparse
import json
from bridge import ROOT, Ledger
from credit_meter import credit_value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('list', 'disable', 'enable'))
    parser.add_argument('--user-id')
    args = parser.parse_args()
    ledger = Ledger(ROOT / 'bridge-state/bridge.sqlite3')
    policy = json.loads((ROOT / 'bridge-policy.json').read_text())
    from public_settings import PublicSettings
    PublicSettings(policy, ROOT / 'bridge-state')
    if args.action != 'list':
        if not args.user_id or not args.user_id.isdigit() or args.user_id.startswith('0'):
            parser.error('A positive forum --user-id is required')
        with ledger.connect() as db:
            account = db.execute('SELECT quota_revision,daily_credit_override FROM accounts WHERE forum_id=?',
                                 (args.user_id,)).fetchone()
        if account is None:
            raise RuntimeError('No mapped account with that forum ID')
        override = None if account['daily_credit_override'] is None else credit_value(account['daily_credit_override'])
        ledger.update_account_controls(args.user_id, account['quota_revision'], override,
                                       args.action == 'disable', policy)
        print(json.dumps({'user_id': args.user_id, 'disabled': args.action == 'disable'}))
        return
    with ledger.connect() as db:
        accounts = [dict(row) for row in db.execute(
            'SELECT forum_id,username,display_name,gateway_id,disabled FROM accounts ORDER BY cast(forum_id AS INTEGER)')]
    print(json.dumps([{**row, 'quota': ledger.summary(row['forum_id'], policy)} for row in accounts],
                     indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
