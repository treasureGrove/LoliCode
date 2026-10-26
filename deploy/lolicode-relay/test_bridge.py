#!/usr/bin/env python3
"""Authentication, accounting and streaming regression tests; all upstreams local."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from bridge import Gateway, Ledger, Rejected, active_models, calendar, create_app, parse_identity, prepare_payload

POLICY = {'daily_requests': 20, 'daily_tokens': 100000, 'max_output_tokens': 4096,
          'max_request_bytes': 131072, 'max_concurrent_per_account': 2,
          'require_confirmed_email': True,
          'models': [{'id': 'mock-model', 'contextLimit': 32768, 'outputLimit': 4096}]}
USER = {'id': '42', 'username': 'member', 'displayName': 'Member'}


def profile(**attrs):
    return {'data': {'type': 'users', 'id': '42', 'attributes': {
        'username': 'member', 'displayName': 'Member', 'email': 'private@example.invalid',
        'isAdmin': False, 'isEmailConfirmed': True, 'suspendedUntil': None, **attrs}}}


class Accounting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = Ledger(Path(self.temp.name) / 'ledger.sqlite3')
        self.ledger.account(USER)

    def tearDown(self):
        self.temp.cleanup()

    def test_parallel_devices_cannot_exceed_twenty_reservations(self):
        policy = {**POLICY, 'max_concurrent_per_account': 100}
        def attempt(_):
            try:
                return self.ledger.reserve('42', 'mock-model', 10, 20, policy)[0]
            except Rejected:
                return None
        with ThreadPoolExecutor(max_workers=12) as workers:
            results = list(workers.map(attempt, range(40)))
        self.assertEqual(sum(item is not None for item in results), 20)
        self.assertEqual(self.ledger.summary('42', policy)['requestsRemaining'], 0)

    def test_token_reservation_settlement_rename_and_failure(self):
        first, _ = self.ledger.reserve('42', 'mock-model', 90000, 9999, POLICY)
        with self.assertRaises(Rejected):
            self.ledger.reserve('42', 'mock-model', 10, 20, POLICY)
        self.ledger.finish(first, 100)
        self.ledger.account({**USER, 'username': 'renamed', 'displayName': '新名字'})
        self.assertEqual(self.ledger.summary('42', POLICY)['tokensRemaining'], 99900)
        second, _ = self.ledger.reserve('42', 'mock-model', 10, 20, POLICY)
        self.ledger.finish(second, release=True)
        self.assertEqual(self.ledger.summary('42', POLICY)['requestsUsed'], 1)
        self.ledger.finish(first, 99999)  # duplicate finalization cannot charge twice
        self.assertEqual(self.ledger.summary('42', POLICY)['tokensUsed'], 100)

    def test_midnight_and_inflight_settle_into_original_day(self):
        before = datetime(2026, 10, 21, 15, 59, 59, tzinfo=timezone.utc)
        after = datetime(2026, 10, 21, 16, 0, 0, tzinfo=timezone.utc)
        request, _ = self.ledger.reserve('42', 'mock-model', 100, 100, POLICY, before)
        self.ledger.finish(request, 125)
        self.assertEqual(calendar(before)[0], '2026-10-21')
        self.assertEqual(calendar(after)[0], '2026-10-22')
        self.assertEqual(self.ledger.summary('42', POLICY, before)['tokensUsed'], 125)
        self.assertEqual(self.ledger.summary('42', POLICY, after)['tokensUsed'], 0)
        self.assertEqual(self.ledger.summary('42', POLICY, after)['requestLimit'], 20)

    def test_restart_and_interrupted_stream_do_not_refund_unknown_usage(self):
        request, _ = self.ledger.reserve('42', 'mock-model', 100, 200, POLICY)
        self.ledger.recover()
        self.ledger.finish(request, release=True)
        self.assertEqual(self.ledger.summary('42', POLICY)['tokensUsed'], 300)
        self.assertEqual(self.ledger.summary('42', POLICY)['requestsUsed'], 1)

    def test_auth_does_not_accept_public_profile_or_wrong_user(self):
        for value in ({'data': {'type': 'users', 'id': '42', 'attributes': {'username': 'public'}}},
                      {**profile(), 'data': {**profile()['data'], 'id': '7'}}):
            with self.assertRaises(Rejected):
                parse_identity(value, '42', POLICY)
        for attrs in ({'isEmailConfirmed': False}, {'suspendedUntil': '2999-01-01T00:00:00Z'}):
            with self.assertRaises(Rejected):
                parse_identity(profile(**attrs), '42', POLICY)
        self.assertEqual(parse_identity(profile(isAdmin=True), '42', POLICY)['id'], '42')
        self.assertEqual(parse_identity(profile(isEmailConfirmed=False), '42',
            {**POLICY, 'require_confirmed_email': False})['id'], '42')

    def test_payload_cannot_override_output_count_or_enable_server_tools(self):
        base = {'model': 'mock-model', 'messages': [{'role': 'user', 'content': 'Hi', 'audio': 'removed'}]}
        payload, bound, output = prepare_payload({**base, 'max_tokens': 999999, 'extra_body': {'max_tokens': 999999}}, POLICY)
        self.assertEqual(output, 4096)
        self.assertNotIn('extra_body', payload)
        self.assertNotIn('audio', payload['messages'][0])
        self.assertGreater(bound, len(json.dumps(payload).encode()))
        for extra in ({'n': 2}, {'model': 'not-allowed'}, {'tools': [{'type': 'web_search'}]},
                      {'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': 'x'}]}]}):
            with self.assertRaises(Rejected):
                prepare_payload({**base, **extra}, POLICY)

    def test_global_request_pool_is_atomic_across_different_accounts(self):
        policy = {**POLICY, 'global_daily_requests': 3, 'global_daily_tokens': 1000000,
                  'max_concurrent_global': 100}
        def attempt(index):
            try:
                self.ledger.reserve(str(100 + index), 'mock-model', 10, 20, policy)
                return 'accepted'
            except Rejected as error:
                return error.code
        with ThreadPoolExecutor(max_workers=12) as workers:
            results = list(workers.map(attempt, range(30)))
        self.assertEqual(results.count('accepted'), 3)
        self.assertEqual(results.count('service_daily_requests_exhausted'), 27)

    def test_global_concurrency_and_token_pool_apply_across_accounts(self):
        policy = {**POLICY, 'max_concurrent_global': 1, 'global_daily_tokens': 100}
        first, output = self.ledger.reserve('42', 'mock-model', 30, 60, policy)
        self.assertEqual(output, 60)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('43', 'mock-model', 10, 20, policy)
        self.assertEqual(blocked.exception.code, 'service_busy')
        self.assertEqual(blocked.exception.retry_after, 2)
        self.ledger.finish(first, 90)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('43', 'mock-model', 10, 20, policy)
        self.assertEqual(blocked.exception.code, 'service_daily_tokens_exhausted')

    def test_global_token_reservations_clip_output_and_reset_at_midnight(self):
        policy = {**POLICY, 'max_concurrent_global': 10, 'global_daily_tokens': 100}
        before = datetime(2026, 10, 21, 15, 59, 59, tzinfo=timezone.utc)
        after = before + timedelta(seconds=1)
        self.ledger.reserve('42', 'mock-model', 10, 60, policy, before)
        _, output = self.ledger.reserve('43', 'mock-model', 10, 60, policy, before)
        self.assertEqual(output, 20)
        with self.assertRaises(Rejected):
            self.ledger.reserve('44', 'mock-model', 1, 1, policy, before)
        _, output = self.ledger.reserve('44', 'mock-model', 10, 60, policy, after)
        self.assertEqual(output, 60)

    def test_failed_attempts_refund_daily_quota_but_still_obey_minute_limit(self):
        policy = {**POLICY, 'global_requests_per_minute': 1}
        now = datetime(2026, 10, 21, 8, 0, 0, tzinfo=timezone.utc)
        request, _ = self.ledger.reserve('42', 'mock-model', 10, 20, policy, now)
        self.ledger.finish(request, release=True)
        self.assertEqual(self.ledger.summary('42', policy, now)['requestsUsed'], 0)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('43', 'mock-model', 10, 20, policy, now + timedelta(seconds=30))
        self.assertEqual(blocked.exception.code, 'service_rate_limited')
        self.assertEqual(blocked.exception.retry_after, 31)
        self.ledger.reserve('43', 'mock-model', 10, 20, policy, now + timedelta(seconds=61))

    def test_trial_expiry_is_fail_closed_in_discovery_and_reservation(self):
        now = datetime(2026, 10, 21, 8, 0, 0, tzinfo=timezone.utc)
        policy = {**POLICY, 'available_until': now.isoformat()}
        self.assertEqual(active_models(policy, now - timedelta(seconds=1)), POLICY['models'])
        self.assertEqual(active_models(policy, now), [])
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('42', 'mock-model', 10, 20, policy, now)
        self.assertEqual(blocked.exception.code, 'trial_unavailable')
        for invalid in ('invalid', '2026-10-21T08:00:00', 123):
            self.assertEqual(active_models({**POLICY, 'available_until': invalid}, now), [])


class HttpBridge(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = 0
        self.current = profile()
        self.captured = None
        self.policy = dict(POLICY)
        async def forum(request):
            if request.headers.get('Authorization') != 'Token ' + 'a' * 40:
                return web.json_response({'data': {'type': 'users', 'id': '42', 'attributes': {'username': 'public'}}})
            return web.json_response(self.current)
        async def upstream(request):
            self.assertEqual(request.headers.get('Authorization'), 'Bearer internal-key')
            self.calls += 1
            self.captured = await request.json()
            if self.captured.get('stream'):
                response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
                await response.prepare(request)
                for chunk in [b'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"probe","arguments":"{}"}}]}}]}\n\n',
                              b'data: {"choices":[],"usage":{"prompt_tokens":',
                              b'100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60}}}\n\ndata: [DONE]\n\n']:
                    await response.write(chunk)
                await response.write_eof()
                return response
            return web.json_response({'choices': [{'message': {'role': 'assistant', 'content': 'OK'}}],
                                      'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
                                                'prompt_tokens_details': {'cached_tokens': 60}}})
        remote = web.Application()
        remote.router.add_get('/api/users/{id}', forum)
        remote.router.add_post('/v1/chat/completions', upstream)
        self.remote = TestServer(remote)
        await self.remote.start_server()
        class Material:
            async def material(self, identity):
                return 'internal-key'
        self.client = TestClient(TestServer(create_app(self.policy, Path(self.temp.name) / 'state.sqlite3',
            forum=str(self.remote.make_url('')).rstrip('/'), gateway=str(self.remote.make_url('')).rstrip('/'),
            material_factory=lambda *args: Material())))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer lc1.42.' + 'a' * 40}
        self.payload = {'model': 'mock-model', 'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 32}

    async def asyncTearDown(self):
        await self.client.close()
        await self.remote.close()
        self.temp.cleanup()

    async def test_forum_auth_ban_revoke_and_usage_are_enforced_per_request(self):
        response = await self.client.post('/v1/chat/completions', json=self.payload)
        self.assertEqual(response.status, 401)
        self.assertEqual(self.calls, 0)
        response = await self.client.post('/v1/chat/completions', json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 200)
        await response.read()
        response = await self.client.get('/account', headers=self.headers)
        result = await response.json()
        self.assertEqual(result['quota']['tokensUsed'], 120)
        self.assertEqual(result['quota']['requestsUsed'], 1)
        self.assertNotIn('email', result['account'])
        self.current = profile(suspendedUntil='2999-01-01T00:00:00Z')
        response = await self.client.post('/v1/chat/completions', json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.calls, 1)
        response = await self.client.post('/v1/chat/completions', json=self.payload,
            headers={'Authorization': 'Bearer lc1.42.' + 'b' * 40})
        self.assertEqual(response.status, 401)
        self.assertEqual(self.calls, 1)

    async def test_stream_usage_across_fragments_and_tools_survive(self):
        response = await self.client.post('/v1/chat/completions', json={**self.payload, 'stream': True}, headers=self.headers)
        body = await response.read()
        self.assertEqual(response.status, 200)
        self.assertIn(b'tool_calls', body)
        self.assertIn(b'[DONE]', body)
        self.assertIn(b'"cached_tokens":60', body)
        self.assertEqual(self.captured['stream_options'], {'include_usage': True})
        result = await (await self.client.get('/account', headers=self.headers)).json()
        self.assertEqual(result['quota']['tokensUsed'], 120)
        self.assertEqual(result['quota']['tokensReserved'], 0)

    async def test_cache_prefix_settings_and_usage_survive_the_bridge(self):
        messages = [{'role': 'system', 'content': 'Stable instructions'},
                    {'role': 'user', 'content': [{'type': 'text', 'text': 'Stable reference',
                                                'cache_control': {'type': 'ephemeral'}}]},
                    {'role': 'user', 'content': 'Current question'}]
        body = {**self.payload, 'messages': messages, 'prompt_cache_key': 'opaque-session-v1',
                'prompt_cache_retention': 'in_memory', 'extra_body': {'store': True}}
        response = await self.client.post('/v1/chat/completions', json=body, headers=self.headers)
        self.assertEqual(response.status, 200)
        result = await response.json()
        self.assertEqual(self.captured['messages'], messages)
        self.assertEqual(self.captured['prompt_cache_key'], 'opaque-session-v1')
        self.assertEqual(self.captured['prompt_cache_retention'], 'in_memory')
        self.assertNotIn('extra_body', self.captured)
        self.assertEqual(result['usage']['prompt_tokens_details']['cached_tokens'], 60)
        account = await (await self.client.get('/account', headers=self.headers)).json()
        # Provider billing discounts do not silently change the user's raw-token allowance.
        self.assertEqual(account['quota']['tokensUsed'], 120)

    async def test_invalid_or_unsupported_cache_settings_do_not_reach_upstream(self):
        for extra in ({'prompt_cache_key': 123}, {'prompt_cache_key': 'x' * 513},
                      {'prompt_cache_retention': 'forever'},
                      {'prompt_cache_options': {'mode': 'explicit', 'ttl': '30m'}}):
            response = await self.client.post('/v1/chat/completions',
                json={**self.payload, **extra}, headers=self.headers)
            self.assertEqual(response.status, 400)
            await response.read()
        self.assertEqual(self.calls, 0)

    async def test_public_status_never_reads_identity_or_returns_credentials(self):
        response = await self.client.get('/public/status')
        data = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(set(data), {'ready', 'modelCount', 'dailyRequests', 'dailyTokens',
                                    'timezone', 'resetsAt', 'limits', 'trialEndsAt'})
        self.assertEqual(data['dailyRequests'], 20)
        self.assertEqual(data['dailyTokens'], 100000)
        self.assertEqual(self.calls, 0)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_global_limit_returns_retry_after_without_forwarding_or_charging(self):
        self.policy['global_requests_per_minute'] = 1
        response = await self.client.post('/v1/chat/completions', json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 200)
        await response.read()
        response = await self.client.post('/v1/chat/completions', json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 429)
        self.assertEqual((await response.json())['error']['code'], 'service_rate_limited')
        self.assertTrue(1 <= int(response.headers['Retry-After']) <= 61)
        self.assertEqual(self.calls, 1)
        account = await (await self.client.get('/account', headers=self.headers)).json()
        self.assertEqual(account['quota']['requestsUsed'], 1)
        self.assertEqual(account['quota']['tokensUsed'], 120)

    async def test_trial_deadline_closes_public_status_models_and_calls(self):
        self.policy['available_until'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        status = await (await self.client.get('/public/status')).json()
        self.assertFalse(status['ready'])
        self.assertEqual(status['modelCount'], 0)
        models = await (await self.client.get('/v1/models', headers=self.headers)).json()
        self.assertEqual(models['data'], [])
        account = await (await self.client.get('/account', headers=self.headers)).json()
        self.assertFalse(account['ready'])
        response = await self.client.post('/v1/chat/completions', json=self.payload, headers=self.headers)
        self.assertEqual(response.status, 503)
        self.assertEqual((await response.json())['error']['code'], 'trial_unavailable')
        self.assertEqual(self.calls, 0)


class MachineIdentity(unittest.IsolatedAsyncioTestCase):
    async def test_revoked_scoped_token_does_not_fall_back_to_password_login(self):
        gateway = Gateway(None, None, {'access_token': 'scoped-test', 'password': 'never-use'}, 'unused')
        calls = []
        async def call(method, path, data=None, token=None):
            calls.append((method, path, token))
            raise Rejected(503, 'gateway_auth_expired', 'revoked')
        gateway.call = call
        with self.assertRaises(Rejected):
            await gateway.admin('GET', '/api/user/1')
        self.assertEqual(calls, [('GET', '/api/user/1', 'scoped-test')])


if __name__ == '__main__':
    unittest.main(verbosity=2)
