"""Credit ledger, migration and local HTTP integration; no real upstream calls."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from bridge import Ledger, Rejected, UNLIMITED_REQUEST_LIMIT, calendar, create_app
from credit_meter import CREDIT_SCALE, default_rate, usage_details
from public_settings import PublicSettings, initial_settings, validate_settings


def policy():
    return {'daily_requests': 20, 'daily_tokens': 100000, 'daily_credits': 100,
            'max_output_tokens': 4096, 'max_request_bytes': 131072,
            'max_concurrent_per_account': 2, 'require_confirmed_email': True,
            'models': [{'id': name, 'name': name, 'contextLimit': 65536,
                        'outputLimit': 4096, 'protocol': 'openai_chat'}
                       for name in ('cheap', 'expensive', 'free')],
            'model_credit_rates': {
                'cheap': default_rate(),
                'expensive': {'input': 2, 'output': 10, 'cacheRead': 0.5, 'cacheWrite': 3},
                'free': dict.fromkeys(default_rate(), 0)}}


def usage(prompt=100, output=20, read=0, write=0):
    return usage_details({'usage': {'prompt_tokens': prompt, 'completion_tokens': output,
                          'total_tokens': prompt + output,
                          'prompt_tokens_details': {'cached_tokens': read,
                                                    'cache_creation_tokens': write}}})


class CreditLedgerIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ledger.sqlite3'
        self.policy = policy()
        self.ledger = Ledger(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def row(self, request_id):
        with self.ledger.connect() as db:
            return dict(db.execute('SELECT * FROM requests WHERE id=?', (request_id,)).fetchone())

    def test_unlimited_daily_requests_exceed_old_caps_until_personal_credit_is_spent(self):
        self.policy.update(daily_requests=None, global_daily_requests=None, daily_credits=0.45)
        for _ in range(225):
            request, _ = self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
            self.ledger.finish(request, usage(1, 1))
        summary = self.ledger.summary('42', self.policy)
        self.assertTrue(summary['requestsUnlimited'])
        self.assertEqual(summary['requestsUsed'], 225)
        self.assertEqual(summary['requestLimit'], UNLIMITED_REQUEST_LIMIT)
        self.assertEqual(summary['requestsRemaining'], UNLIMITED_REQUEST_LIMIT - 225)
        self.assertEqual((summary['creditsUsed'], summary['creditsRemaining']), (0.45, 0))
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'daily_credits_exhausted')

    def test_unlimited_global_requests_still_stop_at_shared_credit_limit(self):
        self.policy.update(daily_requests=None, global_daily_requests=None, global_daily_credits=0.45)
        for number in range(225):
            request, _ = self.ledger.reserve(str(100 + number), 'cheap', 1, 1, self.policy)
            self.ledger.finish(request, usage(1, 1))
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('999', 'cheap', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'service_daily_credits_exhausted')
        with self.ledger.connect() as db:
            total, count = db.execute('SELECT sum(credit_charged),count(*) FROM requests').fetchone()
        self.assertEqual((total, count), (450000, 225))

    def test_missing_daily_caps_are_unlimited_and_protocol_values_are_not_enforced(self):
        self.policy.pop('daily_requests')
        self.policy.pop('global_daily_requests', None)
        original_summary = self.ledger.summary
        # Prove enforcement is independent of the legacy protocol placeholder.
        def compatibility_summary(*args, **kwargs):
            return {**original_summary(*args, **kwargs), 'requestsRemaining': 0}
        with patch.object(self.ledger, 'summary', side_effect=compatibility_summary):
            request, _ = self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
        self.ledger.finish(request, usage(1, 1))
        summary = self.ledger.summary('42', self.policy)
        self.assertTrue(summary['requestsUnlimited'])
        self.assertEqual(summary['requestsRemaining'], UNLIMITED_REQUEST_LIMIT - 1)

    def test_unlimited_daily_caps_preserve_concurrency_and_rpm_protection(self):
        self.policy.update(daily_requests=None, global_daily_requests=None,
                           max_concurrent_per_account=1, max_concurrent_global=1,
                           global_requests_per_minute=2)
        first, _ = self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('42', 'cheap', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'account_busy')
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('43', 'cheap', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'service_busy')
        self.ledger.finish(first, release=True)
        second, _ = self.ledger.reserve('43', 'cheap', 1, 1, self.policy)
        self.ledger.finish(second, release=True)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('44', 'cheap', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'service_rate_limited')
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsUsed'], 0)

    def test_account_allowance_inspection_accepts_unlimited_daily_requests(self):
        import manage_quota
        self.policy.update(daily_requests=None, global_daily_requests=None)
        root = Path(self.temp.name)
        # The inspection CLI uses the real bridge-state layout; give it an
        # independent temporary ledger rather than any workstation/server data.
        state = root / 'bridge-state'
        state.mkdir()
        inspection = Ledger(state / 'bridge.sqlite3')
        inspection.account({'id': '42', 'username': 'member', 'displayName': 'Member'})
        (root / 'bridge-policy.json').write_text(json.dumps(self.policy), encoding='utf8')
        output = io.StringIO()
        with patch.object(manage_quota, 'ROOT', root), patch('sys.argv', ['manage_quota.py', 'list']), redirect_stdout(output):
            manage_quota.main()
        result = json.loads(output.getvalue())
        self.assertTrue(result[0]['quota']['requestsUnlimited'])
        self.assertEqual(result[0]['quota']['requestLimit'], UNLIMITED_REQUEST_LIMIT)
        self.assertNotIn('gateway_password', result[0])

    def test_same_usage_deducts_different_model_rates(self):
        first, _ = self.ledger.reserve('42', 'cheap', 100, 20, self.policy)
        self.ledger.finish(first, usage())
        self.assertEqual(self.row(first)['credit_charged'], 120000)
        second, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        self.ledger.finish(second, usage())
        self.assertEqual(self.row(second)['credit_charged'], 400000)
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual(summary['creditsUsed'], 0.52)
        self.assertEqual(summary['creditsRemaining'], 99.48)
        self.assertEqual(summary['tokensUsed'], 240)
        self.assertEqual(summary['requestsUsed'], 2)

    def test_cache_categories_are_saved_and_billed_without_duplicate_input(self):
        request, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        details = usage(read=60, write=10)
        self.ledger.finish(request, details)
        row = self.row(request)
        self.assertEqual(row['credit_reserved'], 1200000)
        self.assertEqual(row['credit_charged'], 320000)
        self.assertEqual(row['charged'], 120)
        self.assertEqual(json.loads(row['token_details']), details)
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsReserved'], 0)

    def test_admin_rate_save_and_restart_do_not_reprice_inflight_or_history(self):
        request, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        manager = PublicSettings(self.policy, self.temp.name)
        settings = deepcopy(manager.settings)
        settings['modelCreditRates']['expensive'] = dict.fromkeys(default_rate(), 100)
        channels = [{'models': [{'id': model['id'], 'name': model['id']}
                                for model in self.policy['models']]}]
        manager.save(validate_settings(settings), channels)
        self.assertEqual(self.policy['model_credit_rates']['expensive']['input'], 100)
        self.ledger.finish(request, usage(read=60, write=10))
        self.assertEqual(self.row(request)['credit_charged'], 320000)
        self.assertEqual(json.loads(self.row(request)['credit_rate'])['input'], 2)
        next_request, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        self.ledger.finish(next_request, usage(read=60, write=10))
        self.assertEqual(self.row(next_request)['credit_charged'], 12 * CREDIT_SCALE)
        restarted_policy = policy()
        restarted = PublicSettings(restarted_policy, self.temp.name)
        self.assertFalse(restarted.configuration_error)
        self.assertEqual(restarted_policy['model_credit_rates']['expensive']['input'], 100)
        self.ledger = Ledger(self.path)
        self.assertEqual(self.ledger.summary('42', restarted_policy)['creditsUsed'], 12.32)

    def test_parallel_accounts_cannot_overspend_global_credit_pool(self):
        self.policy['global_daily_credits'] = 1
        def attempt(number):
            try:
                request, _ = self.ledger.reserve(str(100 + number), 'cheap', 100, 100, self.policy)
                return request
            except Rejected as error:
                self.assertEqual(error.code, 'service_daily_credits_exhausted')
                return None
        with ThreadPoolExecutor(max_workers=12) as workers:
            results = list(workers.map(attempt, range(30)))
        self.assertEqual(sum(request is not None for request in results), 5)
        with self.ledger.connect() as db:
            total = db.execute('SELECT sum(credit_reserved) FROM requests').fetchone()[0]
        self.assertEqual(total, CREDIT_SCALE)

    def test_credit_balance_clips_output_before_upstream(self):
        self.policy['daily_credits'] = 0.15
        first, output = self.ledger.reserve('42', 'cheap', 100, 100, self.policy)
        self.assertEqual(output, 50)
        self.assertEqual(self.row(first)['credit_reserved'], 150000)
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsRemaining'], 0)
        self.ledger.finish(first, usage())
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsRemaining'], 0.03)
        second, output = self.ledger.reserve('42', 'cheap', 10, 100, self.policy)
        self.assertEqual(output, 20)
        self.assertEqual(self.row(second)['credit_reserved'], 30000)
        self.ledger.finish(second, release=True)
        self.policy.update(daily_credits=100, global_daily_credits=0.17)
        # The first settled call already used 0.12 of the global 0.17 pool.
        third, output = self.ledger.reserve('43', 'cheap', 10, 100, self.policy)
        self.assertEqual(output, 40)
        self.assertEqual(self.row(third)['credit_reserved'], 50000)

    def test_zero_rate_model_with_zero_credit_still_obeys_request_limit(self):
        self.policy.update(daily_credits=0, global_daily_credits=0, daily_requests=2, daily_tokens=1)
        for _ in range(2):
            request, output = self.ledger.reserve('42', 'free', 100, 100, self.policy)
            self.assertEqual(output, 100)
            self.ledger.finish(request, usage(100, 100))
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual(summary['creditsUsed'], 0)
        self.assertEqual(summary['creditsRemaining'], 0)
        self.assertEqual(summary['tokensUsed'], 400)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('42', 'free', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'daily_requests_exhausted')

    def test_recover_keeps_original_credit_reservation_and_cannot_be_refunded(self):
        request, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        self.policy['model_credit_rates']['expensive'] = default_rate()
        self.ledger = Ledger(self.path)
        self.ledger.recover()
        self.assertEqual(self.row(request)['state'], 'uncertain')
        self.assertEqual(self.row(request)['credit_charged'], 1200000)
        self.ledger.finish(request, usage(), release=True)
        self.ledger.recover()
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual(summary['creditsUsed'], 1.2)
        self.assertEqual(summary['creditsReserved'], 0)

    def test_total_only_and_bad_cache_cannot_overspend_reserved_global_credits(self):
        self.policy['model_credit_rates']['expensive'] = {
            'input': 2, 'output': 1, 'cacheRead': 0.5, 'cacheWrite': 20}
        self.policy['global_daily_credits'] = 6
        def attempt(number):
            try:
                request, output = self.ledger.reserve(str(100 + number), 'expensive', 50, 50, self.policy)
                self.assertEqual(output, 50)
                return request
            except Rejected as error:
                self.assertEqual(error.code, 'service_daily_credits_exhausted')
                return None
        with ThreadPoolExecutor(max_workers=12) as workers:
            accepted = [request for request in workers.map(attempt, range(30)) if request is not None]
        self.assertEqual(len(accepted), 3)
        samples = [usage_details({'usage': {'total_tokens': 100}}),
                   usage_details({'usage': {'prompt_tokens': 50, 'completion_tokens': 50,
                                  'prompt_tokens_details': {'cached_tokens': 51}}}),
                   usage_details({'usage': {'total_tokens': 100}})]
        for request, details in zip(accepted, samples):
            reserved = self.row(request)['credit_reserved']
            self.ledger.finish(request, details)
            self.assertLessEqual(self.row(request)['credit_charged'], reserved)
            with self.ledger.connect() as db:
                used, pending = db.execute('''SELECT sum(credit_charged),
                    sum(CASE WHEN state='pending' THEN credit_reserved ELSE 0 END) FROM requests''').fetchone()
            self.assertLessEqual(used + pending, 6 * CREDIT_SCALE)
        with self.ledger.connect() as db:
            charged = db.execute('SELECT sum(credit_charged) FROM requests').fetchone()[0]
        self.assertEqual(charged, 5050000)
        # The refund leaves 0.95 Credit, enough for at most 47 tokens at the
        # highest rate. An input needing 50 tokens must remain blocked.
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('999', 'expensive', 50, 50, self.policy)
        self.assertEqual(blocked.exception.code, 'service_daily_credits_exhausted')

    def test_parallel_finalization_is_idempotent_and_release_refunds(self):
        request, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        with ThreadPoolExecutor(max_workers=8) as workers:
            list(workers.map(lambda _: self.ledger.finish(request, usage()), range(16)))
        self.ledger.finish(request, release=True)
        self.assertEqual(self.row(request)['credit_charged'], 400000)
        released, _ = self.ledger.reserve('42', 'expensive', 100, 20, self.policy)
        self.ledger.finish(released, release=True)
        self.ledger.finish(released, usage())
        self.assertEqual(self.row(released)['state'], 'released')
        self.assertEqual(self.row(released)['credit_charged'], 0)
        self.assertEqual(self.ledger.summary('42', self.policy)['requestsUsed'], 1)
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsUsed'], 0.4)


class CreditLegacyMigration(unittest.TestCase):
    def test_old_schema_migrates_once_and_history_keeps_original_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'old.sqlite3'
            day = calendar()[0]
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('''CREATE TABLE requests (id TEXT PRIMARY KEY,forum_id TEXT NOT NULL,
                    day TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL,model TEXT NOT NULL,created_at REAL NOT NULL)''')
                db.executemany('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)', [
                    ('done', '42', day, 1000, 321, 'charged', 'expensive', 1),
                    ('pending', '42', day, 200, 0, 'pending', 'expensive', 2),
                    ('released', '42', day, 500, 0, 'released', 'expensive', 3)])
            current = policy()
            current['model_credit_rates']['expensive'] = dict.fromkeys(default_rate(), 100)
            ledger = Ledger(path)
            first = ledger.summary('42', current)
            self.assertEqual(first['creditsUsed'], 0.321)
            self.assertEqual(first['creditsReserved'], 0.2)
            self.assertEqual(first['creditsRemaining'], 99.479)
            for _ in range(3):
                ledger = Ledger(path)
                self.assertEqual(ledger.summary('42', current), first)
            ledger.recover()
            recovered = ledger.summary('42', current)
            self.assertEqual(recovered['creditsUsed'], 0.521)
            self.assertEqual(recovered['creditsReserved'], 0)
            ledger = Ledger(path)
            self.assertEqual(ledger.summary('42', current), recovered)

    def test_version_one_admin_settings_upgrade_without_losing_limits_or_rates(self):
        with tempfile.TemporaryDirectory() as directory:
            original = policy()
            original.pop('daily_credits')
            original.pop('model_credit_rates')
            settings = initial_settings(original)
            for key in ('dailyCredits', 'globalDailyCredits', 'modelCreditRates', 'billingConfig'):
                settings.pop(key)
            Path(directory, 'public-settings.json').write_text(json.dumps({
                'version': 1, 'settings': settings, 'models': original['models']}), encoding='utf8')
            manager = PublicSettings(original, directory)
            self.assertFalse(manager.configuration_error)
            self.assertEqual(manager.settings['dailyCredits'], 100)
            self.assertEqual(original['daily_tokens'], 100000)
            self.assertEqual(original['model_credit_rates']['expensive'], default_rate())


class CreditHttpIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.policy = policy()
        self.payloads = []
        async def forum(request):
            return web.json_response({'data': {'type': 'users', 'id': '42', 'attributes': {
                'username': 'member', 'displayName': 'Member', 'email': 'member@example.invalid',
                'isAdmin': False, 'isEmailConfirmed': True, 'suspendedUntil': None}}})
        async def upstream(request):
            self.assertEqual(request.headers['Authorization'], 'Bearer fixture-internal-key')
            payload = await request.json()
            self.payloads.append(payload)
            result = {'choices': [{'message': {'role': 'assistant', 'content': 'fixture'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20,
                'total_tokens': 120, 'prompt_tokens_details': {'cached_tokens': 60,
                                                             'cache_creation_tokens': 10}}}
            if not payload.get('stream'):
                return web.json_response(result)
            response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
            await response.prepare(request)
            data = ('data: ' + json.dumps(result) + '\n\ndata: [DONE]\n\n').encode()
            for chunk in (data[:40], data[40:81], data[81:]):
                await response.write(chunk)
            await response.write_eof()
            return response
        remote = web.Application()
        remote.router.add_get('/api/users/{id}', forum)
        remote.router.add_post('/v1/chat/completions', upstream)
        self.remote = TestServer(remote)
        await self.remote.start_server()
        class Material:
            async def material(self, identity):
                return 'fixture-internal-key'
        base = str(self.remote.make_url('')).rstrip('/')
        self.client = TestClient(TestServer(create_app(self.policy, Path(self.temp.name) / 'ledger.sqlite3',
            forum=base, gateway=base, material_factory=lambda *args: Material())))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer lc1.42.' + 'a' * 40}

    async def asyncTearDown(self):
        await self.client.close()
        await self.remote.close()
        self.temp.cleanup()

    async def test_http_and_fragmented_sse_settle_cache_aware_credit(self):
        for index, stream in enumerate((False, True), start=1):
            response = await self.client.post('/v1/chat/completions', headers=self.headers,
                json={'model': 'expensive', 'messages': [{'role': 'user', 'content': 'Hello'}],
                      'max_tokens': 32, 'stream': stream})
            body = await response.read()
            self.assertEqual(response.status, 200, body)
            result = await (await self.client.get('/account', headers=self.headers)).json()
            self.assertEqual(result['quota']['creditsUsed'], 0.32 * index)
            self.assertEqual(result['quota']['creditsReserved'], 0)
            self.assertEqual(result['quota']['tokensUsed'], 120 * index)
        self.assertEqual(len(self.payloads), 2)
        self.assertTrue(self.payloads[1]['stream_options']['include_usage'])


if __name__ == '__main__':
    unittest.main()
