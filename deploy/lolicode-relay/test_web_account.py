"""Browser authentication regressions; only local mocked forum requests."""
import hashlib
from pathlib import Path
import tempfile
import time
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from bridge import create_app
from test_bridge import POLICY, profile
from web_account import COOKIE, ORIGIN, TTL


class BrowserAccount(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.current = profile()
        self.token_valid = True
        self.login_calls = 0
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
            if self.token_valid and request.headers.get('Authorization') == 'Token ' + 'a' * 40:
                return web.json_response(self.current)
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
