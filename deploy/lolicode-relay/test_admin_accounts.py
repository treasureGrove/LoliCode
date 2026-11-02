"""Per-account controls, local root-auth HTTP and atomic Credit limits."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from bridge import Ledger, Rejected, create_app
from public_settings import ORIGIN
from test_bridge import profile
from test_credit_bridge import policy as credit_policy


class AdminAccountsHttp(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ledger.sqlite3'
        self.policy = credit_policy()
        self.policy.update(daily_requests=None, global_daily_requests=None,
                           global_daily_credits=1000, max_concurrent_per_account=100)
        self.root = {'id': 1, 'role': 100, 'status': 1}
        self.native_calls = 0
        self.model_calls = 0

        async def native_user(request):
            self.native_calls += 1
            if request.headers.get('Authorization') != 'Bearer native-admin-token':
                return web.json_response({'success': False}, status=401)
            return web.json_response({'success': True, 'data': self.root})

        async def forum_user(request):
            if request.headers.get('Authorization') != 'Token ' + 'a' * 40:
                return web.json_response({}, status=401)
            return web.json_response(profile())

        async def upstream(request):
            self.model_calls += 1
            return web.json_response({'choices': [{'message': {'role': 'assistant', 'content': 'ok'}}],
                                      'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})

        native = web.Application()
        native.router.add_get('/api/user/self', native_user)
        native.router.add_get('/api/users/42', forum_user)
        native.router.add_post('/v1/chat/completions', upstream)
        self.native = TestServer(native)
        await self.native.start_server()

        class Material:
            async def material(self, identity):
                return 'private-gateway-key'

        origin = str(self.native.make_url('')).rstrip('/')
        self.client = TestClient(TestServer(create_app(self.policy, self.path, forum=origin, gateway=origin,
                                      material_factory=lambda *args: Material())))
        await self.client.start_server()
        self.ledger = self.client.app['ledger']
        for number, username in (('42', 'member-a'), ('43', 'member-b'), ('44', '%_literal')):
            self.ledger.account({'id': number, 'username': username, 'displayName': username.title()})
        with self.ledger.connect() as db:
            db.execute("UPDATE accounts SET gateway_password='private-gateway-password',gateway_key='private-gateway-key'")
        self.headers = {'Authorization': 'Bearer native-admin-token', 'Origin': ORIGIN}
        self.user_headers = {'Authorization': 'Bearer lc1.42.' + 'a' * 40}

    async def asyncTearDown(self):
        await self.client.close()
        await self.native.close()
        self.temp.cleanup()

    async def get(self, query='', status=200, headers=None):
        response = await self.client.get('/admin/accounts' + query, headers=self.headers if headers is None else headers)
        result = await response.json()
        self.assertEqual(response.status, status, result)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        return result

    async def put(self, value, *, account='42', status=200, headers=None):
        response = await self.client.put('/admin/accounts/' + account, json=value,
                                         headers=self.headers if headers is None else headers)
        result = await response.json()
        self.assertEqual(response.status, status, result)
        return result

    def change(self, revision=0, override=None, disabled=False):
        return {'revision': revision, 'dailyCreditsOverride': override, 'disabled': disabled}

    def state(self):
        with self.ledger.connect() as db:
            return [tuple(row) for row in db.execute('SELECT * FROM accounts ORDER BY forum_id')], \
                   [tuple(row) for row in db.execute('SELECT * FROM requests ORDER BY id')], \
                   db.execute('SELECT revision FROM quota_ledger_revision').fetchone()[0]

    async def test_root_privilege_and_origin_are_checked_for_both_routes(self):
        await self.get(status=401, headers={})
        self.assertEqual(self.native_calls, 0)
        for value in ({'role': 10}, {'role': 1}, {'role': True}, {'role': '100'}, {'id': 0}, {'id': '1'}, {'id': True},
                      {'status': 2}, {'status': True}):
            with self.subTest(value=value):
                self.root = {'id': 1, 'role': 100, 'status': 1, **value}
                await self.get(status=403)
                await self.put(self.change(), status=403)
        self.root = {'id': 1, 'role': 100, 'status': 1}
        for headers in ({**self.headers, 'Origin': 'https://hostile.invalid'},
                        {**self.headers, 'Sec-Fetch-Site': 'cross-site'},
                        {**self.headers, 'Sec-Fetch-Site': 'same-site'}):
            await self.get(status=403, headers=headers)
            await self.put(self.change(), status=403, headers=headers)
        await self.get(headers={'Authorization': 'Bearer native-admin-token'})
        await self.put(self.change(), status=403, headers={'Authorization': 'Bearer native-admin-token'})
        await self.get(status=401, headers={**self.headers, 'Authorization': 'Bearer wrong-token'})
        response = await self.client.put('/admin/accounts/42', data='{}', headers=self.headers)
        self.assertEqual(response.status, 415)
        self.assertEqual(self.model_calls, 0)

    async def test_account_controls_and_ledger_revision_roll_back_together(self):
        before = self.state()
        with patch.object(self.ledger, '_advance_revision', side_effect=ValueError('simulated failed transaction')):
            with self.assertRaises(ValueError):
                self.ledger.update_account_controls('42', 0, 0.25, True, self.policy)
        self.assertEqual(self.state(), before)

    async def test_get_is_read_only_paginated_searchable_and_never_returns_gateway_secrets(self):
        before = self.state()
        result = await self.get('?page=2&pageSize=1&q=member')
        self.assertEqual((result['page'], result['pageSize'], result['total']), (2, 1, 2))
        self.assertEqual(result['accounts'][0]['id'], '43')
        self.assertEqual(set(result['accounts'][0]), {'id', 'username', 'displayName', 'disabled',
                         'dailyCreditsOverride', 'revision', 'quota'})
        self.assertEqual(result['defaultDailyCredits'], 100)
        self.assertEqual(result['globalDailyCredits'], 1000)
        self.assertEqual(result['globalUsage'], {'used': 0, 'reserved': 0, 'remaining': 1000})
        literal = await self.get('?q=%25_')
        self.assertEqual([account['id'] for account in literal['accounts']], ['44'])
        self.assertEqual((await self.get('?q=missing'))['total'], 0)
        self.assertEqual((await self.get('?q=42'))['accounts'][0]['id'], '42')
        self.assertEqual(self.state(), before)
        encoded = json.dumps(result)
        for secret in ('gateway_password', 'gateway_key', 'gateway_id', 'private-gateway-password',
                       'private-gateway-key', 'native-admin-token'):
            self.assertNotIn(secret, encoded)

    async def test_invalid_pagination_and_strict_update_bodies_never_write(self):
        before = self.state()
        for query in ('?page=0', '?page=-1', '?page=true', '?pageSize=101', '?page=1&page=2',
                      '?unknown=1', '?q=' + 'x' * 257):
            await self.get(query, status=400)
        invalid = [[], {}, {**self.change(), 'apiKey': 'secret'},
                   {key: value for key, value in self.change().items() if key != 'disabled'}]
        for key, values in {'revision': (True, -1, 1.5, '0', 2**53 - 1),
                            'dailyCreditsOverride': (-1, True, '1', 0.0000001, 1000000.000001,
                                                     float('nan'), float('inf')),
                            'disabled': (0, 1, 'false', None)}.items():
            invalid.extend({**self.change(), key: value} for value in values)
        for value in invalid:
            with self.subTest(value=value):
                await self.put(value, status=400)
        for identity in ('0', '042', '-1', 'member'):
            await self.put(self.change(), account=identity, status=400)
        response = await self.client.put('/admin/accounts/42', data='{bad json',
                                         headers={**self.headers, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400)
        response = await self.client.put('/admin/accounts/42',
            data='{"revision":0,"revision":1,"dailyCreditsOverride":null,"disabled":false}',
            headers={**self.headers, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400)
        response = await self.client.put('/admin/accounts/42', data=' ' * 8193,
                                         headers={**self.headers, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 413)
        self.assertEqual(self.state(), before)

    async def test_cas_noop_missing_and_per_account_isolation(self):
        unchanged = await self.put(self.change())
        self.assertEqual((unchanged['account']['revision'], self.state()[2]), (0, 0))
        updated = (await self.put(self.change(override=1.234567)))['account']
        self.assertEqual((updated['revision'], updated['dailyCreditsOverride'], updated['quota']['creditBalance']['limit']),
                         (1, 1.234567, 1.234567))
        self.assertEqual(updated['quota']['creditBalance']['ledgerRevision'], 1)
        self.assertEqual(self.ledger.summary('43', self.policy)['creditLimit'], 100)
        await self.put(self.change(override=2), status=409)
        await self.put(self.change(), account='999', status=404)
        await self.put(self.change(1, 1.234567))
        self.assertEqual(self.state()[2], 1)
        self.ledger = Ledger(self.path)
        self.assertEqual(self.ledger.summary('42', self.policy)['creditLimit'], 1.234567)
        self.assertEqual((await self.get('?q=42'))['accounts'][0]['revision'], 1)

    async def test_zero_is_distinct_from_inheritance_and_defaults_remain_live(self):
        await self.put(self.change(override=0))
        self.assertEqual(self.ledger.summary('42', self.policy)['creditBalance']['limit'], 0)
        with self.assertRaises(Rejected):
            self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
        free, _ = self.ledger.reserve('42', 'free', 1, 1, self.policy)
        self.ledger.finish(free, 2)
        await self.put(self.change(1, 1))
        self.policy['daily_credits'] = 200
        self.assertEqual(self.ledger.summary('42', self.policy)['creditLimit'], 1)
        self.assertEqual(self.ledger.summary('43', self.policy)['creditLimit'], 200)
        restored = (await self.put(self.change(2)))['account']
        self.assertIsNone(restored['dailyCreditsOverride'])
        self.assertEqual(restored['quota']['creditLimit'], 200)
        self.assertEqual((await self.get())['globalDailyCredits'], 1000)

    async def test_lowering_or_disabling_keeps_history_and_existing_reservation_settlement(self):
        await self.put(self.change(override=0.05))
        first, _ = self.ledger.reserve('42', 'cheap', 10, 20, self.policy)
        self.ledger.finish(first, 15)
        pending, _ = self.ledger.reserve('42', 'cheap', 10, 20, self.policy)
        before = self.state()[1]
        lower = (await self.put(self.change(1, 0.01, True)))['account']
        self.assertEqual(self.state()[1], before)
        self.assertEqual(lower['quota']['creditBalance']['remaining'], 0)
        self.assertEqual((lower['quota']['creditsUsed'], lower['quota']['creditsReserved']), (0.015, 0.03))
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('42', 'free', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'account_disabled')
        self.ledger.finish(pending, 12)
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsUsed'], 0.027)
        await self.put(self.change(2, 0.01))
        with self.assertRaises(Rejected) as depleted:
            self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
        self.assertEqual(depleted.exception.code, 'daily_credits_exhausted')

    async def test_personal_overrides_do_not_expand_global_pool_or_filter_global_usage(self):
        self.policy['global_daily_credits'] = 0.05
        await self.put(self.change(override=1000))
        first, output = self.ledger.reserve('42', 'cheap', 10, 20, self.policy)
        second, clipped = self.ledger.reserve('43', 'cheap', 10, 20, self.policy)
        self.assertEqual((output, clipped), (20, 10))
        with self.assertRaises(Rejected) as depleted:
            self.ledger.reserve('44', 'cheap', 1, 1, self.policy)
        self.assertEqual(depleted.exception.code, 'service_daily_credits_exhausted')
        listing = await self.get('?q=member-a')
        self.assertEqual(listing['total'], 1)
        self.assertEqual(listing['globalUsage'], {'used': 0, 'reserved': 0.05, 'remaining': 0})
        self.ledger.finish(first, release=True)
        self.ledger.finish(second, 10)
        self.assertEqual((await self.get())['globalUsage'], {'used': 0.01, 'reserved': 0, 'remaining': 0.04})
        self.policy['global_daily_credits'] = None
        listing = await self.get()
        self.assertIsNone(listing['globalDailyCredits'])
        self.assertEqual(listing['globalUsage'], {'used': 0.01, 'reserved': 0, 'remaining': None})

    async def test_parallel_requests_cannot_overdraw_personal_override(self):
        await self.put(self.change(override=0.05))
        def reserve(_):
            try:
                return self.ledger.reserve('42', 'cheap', 10, 20, self.policy)
            except Rejected:
                return None
        with ThreadPoolExecutor(max_workers=8) as workers:
            successes = [result for result in workers.map(reserve, range(24)) if result]
        self.assertEqual(sorted(output for _, output in successes), [10, 20])
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsReserved'], 0.05)

    async def test_parallel_admin_updates_with_same_revision_have_one_winner(self):
        async def save(value):
            response = await self.client.put('/admin/accounts/42', json=self.change(override=value), headers=self.headers)
            await response.read()
            return response.status
        self.assertEqual(sorted(await asyncio.gather(save(10), save(20))), [200, 409])
        account = (await self.get('?q=42'))['accounts'][0]
        self.assertEqual((account['revision'], account['quota']['creditBalance']['ledgerRevision']), (1, 1))
        self.assertIn(account['dailyCreditsOverride'], (10, 20))

    async def test_http_account_summary_and_new_requests_use_effective_override(self):
        await self.put(self.change(override=1))
        response = await self.client.get('/account', headers=self.user_headers)
        self.assertEqual(response.status, 200)
        quota = (await response.json())['quota']
        self.assertEqual((quota['creditBalance']['limit'], quota['creditLimit']), (1, 1))
        await self.put(self.change(1, 0))
        response = await self.client.post('/v1/chat/completions', headers=self.user_headers,
            json={'model': 'cheap', 'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 1})
        self.assertEqual(response.status, 429)
        self.assertEqual(self.model_calls, 0)

    async def test_operator_cli_shares_revision_and_preserves_personal_override(self):
        await self.put(self.change(override=3))
        import manage_quota
        root = Path(self.temp.name)
        (root / 'bridge-state').mkdir()
        database = root / 'bridge-state/bridge.sqlite3'
        with self.ledger.connect() as source, closing(sqlite3.connect(database)) as target:
            source.backup(target)
        (root / 'bridge-policy.json').write_text(json.dumps(self.policy))
        with patch.object(manage_quota, 'ROOT', root), patch('sys.argv', ['manage_quota.py', 'disable', '--user-id', '42']), \
                redirect_stdout(io.StringIO()):
            manage_quota.main()
        operated = Ledger(database).admin_accounts(self.policy, query='42')['accounts'][0]
        self.assertTrue(operated['disabled'])
        self.assertEqual((operated['dailyCreditsOverride'], operated['revision']), (3, 2))
        self.assertEqual(operated['quota']['creditBalance']['ledgerRevision'], 2)


class AccountSchemaMigration(unittest.TestCase):
    def test_existing_identity_and_request_rows_survive_additive_migration_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'legacy.sqlite3'
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('''CREATE TABLE accounts(forum_id TEXT PRIMARY KEY,username TEXT NOT NULL,
                    display_name TEXT NOT NULL,gateway_id INTEGER UNIQUE,gateway_password TEXT NOT NULL,
                    gateway_key TEXT,disabled INTEGER NOT NULL DEFAULT 0,updated_at REAL NOT NULL)''')
                db.execute("INSERT INTO accounts VALUES('42','member','Member',7,'private-password','private-key',0,1)")
                old = db.execute('SELECT * FROM accounts').fetchall()
            ledger = Ledger(path)
            Ledger(path)
            with ledger.connect() as db:
                self.assertEqual([tuple(row) for row in db.execute('''SELECT forum_id,username,display_name,gateway_id,
                    gateway_password,gateway_key,disabled,updated_at FROM accounts''')], old)
            listing = ledger.admin_accounts(credit_policy())
            account = listing['accounts'][0]
            self.assertIsNone(account['dailyCreditsOverride'])
            self.assertEqual(account['revision'], 0)
            self.assertEqual(account['quota']['creditBalance']['ledgerRevision'], 0)


if __name__ == '__main__':
    unittest.main()
