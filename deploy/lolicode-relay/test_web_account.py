"""Browser authentication regressions; only local mocked forum requests."""
import hashlib
from contextlib import contextmanager
from datetime import date, datetime, timedelta
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from bridge import calendar, create_app
from test_bridge import POLICY, profile
from web_account import COOKIE, ORIGIN, TTL


class BrowserAccount(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.current = profile()
        self.token_valid = True
        self.login_calls = 0
        self.forum_calls = 0
        self.forum_response = None
        self.material_calls = 0

        async def login(request):
            self.login_calls += 1
            value = await request.json()
            self.assertIs(value['remember'], False)
            if value['identification'] != 'member' or value['password'] != 'fixture-password':
                return web.json_response({'errors': []}, status=401)
            return web.json_response(self.forum_response if self.forum_response is not None else
                                     {'userId': 42, 'token': 'a' * 40})

        async def forum(request):
            self.forum_calls += 1
            if self.token_valid and request.headers.get('Authorization') == 'Token ' + 'a' * 40:
                return web.json_response(self.current)
            if request.match_info['id'] == '7' and request.headers.get('Authorization') == 'Token ' + 'b' * 40:
                other = profile(username='other', displayName='Other', email='other-private@example.invalid')
                other['data']['id'] = '7'
                return web.json_response(other)
            return web.json_response({'data': {'id': '42', 'type': 'users', 'attributes': {'username': 'public'}}})

        remote = web.Application()
        remote.router.add_post('/api/token', login)
        remote.router.add_get('/api/users/{id}', forum)
        self.remote = TestServer(remote)
        await self.remote.start_server()
        owner = self

        class Material:
            async def material(self, user):
                owner.material_calls += 1
                return 'never-return-this-key'

        self.client = TestClient(TestServer(create_app(POLICY, Path(self.temp.name) / 'state.sqlite3',
            forum=str(self.remote.make_url('')).rstrip('/'), material_factory=lambda *args: Material())))
        await self.client.start_server()
        self.headers = {'Origin': ORIGIN, 'Sec-Fetch-Site': 'same-origin'}
        self.credentials = {'identification': 'member', 'password': 'fixture-password'}

    async def asyncTearDown(self):
        await self.client.close()
        await self.remote.close()
        self.temp.cleanup()

    async def login(self):
        response = await self.client.post('/web/login', json=self.credentials, headers=self.headers)
        self.assertEqual(response.status, 200, await response.text())
        session = response.cookies[COOKIE].value
        return response, {'Cookie': COOKIE + '=' + session}

    async def test_existing_account_login_private_cookie_and_shared_client_quota(self):
        response, cookie = await self.login()
        value = await response.json()
        self.assertEqual(value['account']['id'], '42')
        self.assertEqual(value['quota']['requestLimit'], 20)
        self.assertEqual(value['quota']['tokenLimit'], 100000)
        text = await response.text()
        for secret in ('a' * 40, 'fixture-password', 'never-return-this-key', 'private@example.invalid'):
            self.assertNotIn(secret, text)
        saved = response.cookies[COOKIE]
        self.assertTrue(saved['secure'])
        self.assertTrue(saved['httponly'])
        self.assertEqual(saved['samesite'], 'Lax')
        self.assertEqual(saved['path'], '/')
        self.assertNotIn('domain=', response.headers['Set-Cookie'].lower())
        self.assertEqual(int(saved['max-age']), TTL)
        ledger = self.client.server.app['ledger']
        request_id, _ = ledger.reserve('42', 'mock-model', 100, 30, POLICY)
        ledger.finish(request_id, 123)
        for path, headers in [('/web/account', cookie), ('/account', {'Authorization': 'Bearer lc1.42.' + 'a' * 40})]:
            result = await (await self.client.get(path, headers=headers)).json()
            self.assertEqual(result['quota']['tokensUsed'], 123)
            self.assertEqual(result['quota']['requestsUsed'], 1)
        with ledger.connect() as db:
            row = dict(db.execute('SELECT * FROM web_sessions').fetchone())
        self.assertEqual(row['digest'], hashlib.sha256(saved.value.encode()).hexdigest())
        self.assertNotIn(saved.value, str(row))

    async def test_no_browser_cookie_access_without_login_or_inference_authorization(self):
        response = await self.client.get('/web/account')
        self.assertEqual(response.status, 401)
        _, cookie = await self.login()
        for path in ('/account', '/v1/models'):
            response = await self.client.get(path, headers=cookie)
            self.assertEqual(response.status, 401)
        response = await self.client.post('/v1/chat/completions', headers=cookie,
            json={'model': 'mock-model', 'messages': [{'role': 'user', 'content': 'x'}]})
        self.assertEqual(response.status, 401)

    async def test_cross_origin_login_logout_and_reads_rejected_before_forum(self):
        for headers in ({}, {'Origin': 'https://evil.invalid'},
                        {'Origin': ORIGIN, 'Sec-Fetch-Site': 'same-site'}):
            response = await self.client.post('/web/login', json=self.credentials, headers=headers)
            self.assertEqual(response.status, 403)
        response = await self.client.post('/web/login', data='identification=member', headers=self.headers)
        self.assertEqual(response.status, 415)
        self.assertEqual(self.login_calls, 0)
        _, cookie = await self.login()
        response = await self.client.post('/web/logout', json={}, headers={**cookie, 'Origin': 'https://evil.invalid'})
        self.assertEqual(response.status, 403)
        response = await self.client.get('/web/account', headers={**cookie, 'Origin': 'https://evil.invalid'})
        self.assertEqual(response.status, 403)
        self.assertNotIn('Access-Control-Allow-Origin', response.headers)

    async def test_wrong_password_invalid_forum_reply_and_bans_never_create_session(self):
        response = await self.client.post('/web/login', json={**self.credentials, 'password': 'wrong'}, headers=self.headers)
        self.assertEqual(response.status, 401)
        self.assertNotIn(COOKIE, response.cookies)
        self.forum_response = {'userId': 42, 'token': 'invalid'}
        response = await self.client.post('/web/login', json=self.credentials, headers=self.headers)
        self.assertEqual(response.status, 503)
        self.forum_response = None
        self.current = profile(suspendedUntil='2999-01-01T00:00:00Z')
        response = await self.client.post('/web/login', json=self.credentials, headers=self.headers)
        self.assertEqual(response.status, 403)
        with self.client.server.app['ledger'].connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM web_sessions').fetchone()[0], 0)

    async def test_logout_expiry_and_upstream_revocation_invalidate_sessions(self):
        _, cookie = await self.login()
        response = await self.client.post('/web/logout', json={}, headers={**self.headers, **cookie})
        self.assertEqual(response.status, 200)
        response = await self.client.get('/web/account', headers=cookie)
        self.assertEqual(response.status, 401)
        _, cookie = await self.login()
        with self.client.server.app['ledger'].connect() as db:
            db.execute('UPDATE web_sessions SET expires_at=?', (time.time() - 1,))
        response = await self.client.get('/web/account', headers=cookie)
        self.assertEqual(response.status, 401)
        _, cookie = await self.login()
        self.token_valid = False
        response = await self.client.get('/web/account', headers=cookie)
        self.assertEqual(response.status, 401)
        with self.client.server.app['ledger'].connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM web_sessions').fetchone()[0], 0)

    async def test_account_disabled_and_suspension_apply_to_existing_browser_session(self):
        _, cookie = await self.login()
        self.current = profile(suspendedUntil='2999-01-01T00:00:00Z')
        response = await self.client.get('/web/account', headers=cookie)
        self.assertEqual(response.status, 403)
        self.current = profile()
        _, cookie = await self.login()
        with self.client.server.app['ledger'].connect() as db:
            db.execute("UPDATE accounts SET disabled=1 WHERE forum_id='42'")
        response = await self.client.get('/web/account', headers=cookie)
        self.assertEqual(response.status, 403)

    async def test_usage_is_private_complete_and_separates_reserved_from_charged(self):
        _, cookie = await self.login()
        app = self.client.server.app
        ledger = app['ledger']
        today = date.fromisoformat(calendar()[0])
        stamp = datetime.fromisoformat(today.isoformat() + 'T12:00:00+08:00').timestamp()
        with ledger.connect() as db:
            for index in range(25):
                db.execute('''INSERT INTO requests
                    (id,forum_id,day,reserved,charged,state,model,created_at) VALUES(?,?,?,?,?,?,?,?)''',
                    (f'own-{index:02}', '42', today.isoformat(), 100, index + 1,
                     'charged', 'mock-model', stamp + index))
            rows = [
                ('own-uncertain', '42', today.isoformat(), 50, 50, 'uncertain', 'mock-model', stamp + 26),
                ('own-pending', '42', today.isoformat(), 80, 0, 'pending', 'mock-model', stamp + 27),
                ('own-released', '42', today.isoformat(), 500, 0, 'released', 'mock-model', stamp + 28),
                ('own-six-days', '42', (today - timedelta(days=6)).isoformat(), 90, 9,
                 'charged', 'mock-model', stamp - 6 * 86400),
                ('own-old', '42', (today - timedelta(days=7)).isoformat(), 500, 400,
                 'charged', 'mock-model', stamp - 7 * 86400),
                ('other-private-id', '7', today.isoformat(), 9999, 9999,
                 'charged', 'other-private-model', stamp + 30),
            ]
            db.executemany('''INSERT INTO requests
                (id,forum_id,day,reserved,charged,state,model,created_at) VALUES(?,?,?,?,?,?,?,?)''', rows)
            before = [tuple(row) for row in db.execute('SELECT * FROM requests ORDER BY id')]
        response = await self.client.get('/web/usage?forum_id=7', headers=cookie)
        self.assertEqual(response.status, 200, await response.text())
        value = await response.json()
        self.assertEqual(value['plan'], {'id': 'public-free', 'name': '公益免费',
                                       'currency': 'CNY', 'billedAmount': 0})
        self.assertEqual(value['today'], {'requests': 27, 'tokens': 375, 'reservedTokens': 80})
        self.assertEqual(len(value['daily']), 7)
        self.assertEqual(value['daily'][0], {'day': (today - timedelta(days=6)).isoformat(),
                                          'requests': 1, 'tokens': 9, 'reservedTokens': 0})
        self.assertEqual(value['daily'][-1]['tokens'], value['today']['tokens'])
        self.assertTrue(all(day['requests'] == 0 for day in value['daily'][1:-1]))
        summary = ledger.summary('42', app['policy'])
        self.assertEqual(value['today']['requests'], summary['requestsUsed'])
        self.assertEqual(value['today']['tokens'], summary['tokensUsed'])
        self.assertEqual(value['today']['reservedTokens'], summary['tokensReserved'])
        self.assertEqual(len(value['records']), 20)
        self.assertEqual(value['records'][0]['id'], 'own-released')
        pending = next(row for row in value['records'] if row['state'] == 'pending')
        self.assertEqual((pending['tokens'], pending['reservedTokens']), (0, 80))
        uncertain = next(row for row in value['records'] if row['state'] == 'uncertain')
        self.assertEqual((uncertain['tokens'], uncertain['reservedTokens']), (50, 0))
        for record in value['records']:
            self.assertEqual(set(record), {'id', 'model', 'createdAt', 'state', 'tokens', 'reservedTokens'})
        text = json.dumps(value)
        for secret in ('other-private', 'a' * 40, 'b' * 40, 'fixture-password',
                       'never-return-this-key', 'private@example.invalid', 'gateway_key', 'prompt'):
            self.assertNotIn(secret, text)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        session = app['web_sessions'].create('7', 'b' * 40)
        other = await (await self.client.get('/web/usage',
            headers={'Cookie': COOKIE + '=' + session})).json()
        self.assertEqual(other['today']['tokens'], 9999)
        self.assertEqual([row['id'] for row in other['records']], ['other-private-id'])
        self.assertNotIn('own-', json.dumps(other))
        with ledger.connect() as db:
            self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM requests ORDER BY id')], before)

    async def test_usage_invalid_or_expired_cookie_never_reads_request_history(self):
        ledger = self.client.server.app['ledger']
        session = self.client.server.app['web_sessions'].create('42', 'a' * 40)
        with ledger.connect() as db:
            db.execute('UPDATE web_sessions SET expires_at=?', (time.time() - 1,))
        queries = []
        original = ledger.connect

        @contextmanager
        def trace():
            with original() as db:
                db.set_trace_callback(queries.append)
                yield db

        initial_forum_calls = self.forum_calls
        with patch.object(ledger, 'connect', trace):
            for headers in ({}, {'Cookie': COOKIE + '=invalid'},
                            {'Cookie': COOKIE + '=' + session},
                            {'Cookie': COOKIE + '=' + session, 'Origin': 'https://evil.invalid'}):
                response = await self.client.get('/web/usage', headers=headers)
                self.assertIn(response.status, (401, 403))
        self.assertEqual(self.forum_calls, initial_forum_calls)
        self.assertFalse(any('FROM requests' in query for query in queries))

    async def test_usage_revalidates_revoked_and_disabled_accounts(self):
        _, cookie = await self.login()
        self.token_valid = False
        response = await self.client.get('/web/usage', headers=cookie)
        self.assertEqual(response.status, 401)
        self.token_valid = True
        _, cookie = await self.login()
        with self.client.server.app['ledger'].connect() as db:
            db.execute("UPDATE accounts SET disabled=1 WHERE forum_id='42'")
        response = await self.client.get('/web/usage', headers=cookie)
        self.assertEqual(response.status, 403)


if __name__ == '__main__':
    unittest.main(verbosity=2)
