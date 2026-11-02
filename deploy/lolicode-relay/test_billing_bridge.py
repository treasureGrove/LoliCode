"""Billing snapshots, money ledger and web integration; all upstreams local."""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from billing_meter import default_billing_config
from bridge import Ledger, Rejected, calendar, create_app, public_models
from credit_meter import default_rate, usage_details
from public_settings import PublicSettings, initial_settings, validate_settings
from web_account import COOKIE, ORIGIN


def billing_policy():
    return {'daily_requests': 20, 'daily_tokens': 100000, 'daily_credits': 100,
            'max_output_tokens': 4096, 'max_request_bytes': 131072,
            'max_concurrent_per_account': 2, 'require_confirmed_email': True,
            'models': [{'id': name, 'name': name, 'contextLimit': 65536,
                        'outputLimit': 4096, 'protocol': 'openai_chat'}
                       for name in ('token-model', 'fixed-model', 'legacy-model')],
            'billing_config': {'currency': 'USD', 'creditsPerUnit': 100, 'modelPrices': {
                'token-model': {'mode': 'tokens', 'prices': {
                    'input': 2, 'output': 10, 'cacheRead': 0.5, 'cacheWrite': 3}},
                'fixed-model': {'mode': 'request', 'price': 0.02}}}}


def billable_usage():
    return usage_details({'usage': {'prompt_tokens': 100, 'completion_tokens': 20,
        'total_tokens': 120, 'prompt_tokens_details': {
            'cached_tokens': 60, 'cache_creation_tokens': 10}}})


def catalog(current):
    return [{'models': [{'id': model['id'], 'name': model['id']} for model in current['models']]}]


class BillingLedger(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ledger.sqlite3'
        self.policy = billing_policy()
        self.ledger = Ledger(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def row(self, request_id):
        with self.ledger.connect() as db:
            return dict(db.execute('SELECT * FROM requests WHERE id=?', (request_id,)).fetchone())

    def test_currency_token_prices_become_credit_and_cache_is_not_duplicated(self):
        request, output = self.ledger.reserve('42', 'token-model', 100, 20, self.policy)
        self.assertEqual(output, 20)
        before = self.row(request)
        self.assertEqual(before['credit_reserved'], 120000)
        reservation = json.loads(before['cost_details'])
        self.assertEqual((reservation['amount'], reservation['currency'], reservation['basis']),
                         ('0.0012', 'USD', 'reservation'))
        self.ledger.finish(request, billable_usage(), completed=True)
        after = self.row(request)
        self.assertEqual((after['state'], after['charged'], after['credit_charged']), ('charged', 120, 32000))
        self.assertEqual(json.loads(after['token_details'])['input'], 30)
        money = json.loads(after['cost_details'])
        self.assertEqual((money['amount'], money['basis'], money['creditsPerUnit']), ('0.00032', 'usage', 100))
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsRemaining'], 99.968)

    def test_fixed_success_without_usage_charges_once_and_records_actual_fixed_cost(self):
        request, output = self.ledger.reserve('42', 'fixed-model', 100, 20, self.policy)
        self.assertEqual(output, 20)
        self.assertEqual(self.row(request)['credit_reserved'], 2000000)
        self.ledger.finish(request, completed=True)
        row = self.row(request)
        self.assertEqual((row['state'], row['charged'], row['credit_charged']), ('charged', 0, 2000000))
        self.assertIsNone(row['token_details'])
        self.assertEqual(json.loads(row['cost_details']), {'currency': 'USD', 'amount': '0.02',
            'basis': 'request', 'mode': 'request', 'creditsPerUnit': 100})
        self.ledger.finish(request, completed=True)
        self.ledger.finish(request, release=True)
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual((summary['requestsUsed'], summary['tokensUsed'], summary['creditsUsed']), (1, 0, 2))

    def test_failed_fixed_and_token_requests_release_credit_and_currency_cost(self):
        for model in ('fixed-model', 'token-model'):
            with self.subTest(model=model):
                request, _ = self.ledger.reserve('42', model, 100, 20, self.policy)
                self.ledger.finish(request, release=True)
                row = self.row(request)
                self.assertEqual((row['state'], row['charged'], row['credit_charged']), ('released', 0, 0))
                self.assertIsNone(row['cost_details'])
                self.ledger.finish(request, billable_usage(), completed=True)
                self.assertEqual(self.row(request)['state'], 'released')
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual((summary['requestsUsed'], summary['creditsUsed'], summary['creditsReserved']), (0, 0, 0))

    def test_missing_token_usage_retains_uncertain_reservation_and_cost(self):
        request, _ = self.ledger.reserve('42', 'token-model', 100, 20, self.policy)
        before = self.row(request)
        # A complete HTTP response without token usage still cannot establish a
        # discounted actual cost for token billing.
        self.ledger.finish(request, completed=True)
        row = self.row(request)
        self.assertEqual((row['state'], row['charged'], row['credit_charged']), ('uncertain', 120, 120000))
        self.assertEqual(row['cost_details'], before['cost_details'])
        self.assertEqual(json.loads(row['cost_details'])['basis'], 'reservation')

    def test_crash_recovery_preserves_currency_reservation_without_repricing(self):
        request, _ = self.ledger.reserve('42', 'token-model', 100, 20, self.policy)
        before = self.row(request)
        self.ledger = Ledger(self.path)
        self.ledger.recover()
        self.assertEqual(self.row(request)['cost_details'], before['cost_details'])
        self.assertEqual(self.row(request)['billing_snapshot'], before['billing_snapshot'])
        self.assertEqual(self.row(request)['credit_charged'], 120000)
        self.ledger.finish(request, release=True)
        self.assertEqual(self.row(request)['state'], 'uncertain')

    def test_admin_currency_price_and_conversion_change_keeps_inflight_snapshot(self):
        request, _ = self.ledger.reserve('42', 'token-model', 100, 20, self.policy)
        manager = PublicSettings(self.policy, self.temp.name)
        settings = deepcopy(manager.settings)
        settings['billingConfig']['currency'] = 'CNY'
        settings['billingConfig']['creditsPerUnit'] = 200
        settings['billingConfig']['modelPrices']['token-model']['prices']['output'] = 100
        manager.save(validate_settings(settings), catalog(self.policy))
        self.ledger.finish(request, billable_usage(), completed=True)
        first = self.row(request)
        self.assertEqual(first['credit_charged'], 32000)
        self.assertEqual(json.loads(first['cost_details'])['currency'], 'USD')
        self.assertEqual(json.loads(first['billing_snapshot'])['revision'], 0)
        current = billing_policy()
        restarted = PublicSettings(current, self.temp.name)
        self.assertFalse(restarted.configuration_error)
        self.assertEqual(current['billing_revision'], 1)
        self.assertEqual(current['billing_config']['currency'], 'CNY')
        self.ledger = Ledger(self.path)
        next_request, _ = self.ledger.reserve('42', 'token-model', 100, 20, current)
        self.ledger.finish(next_request, billable_usage(), completed=True)
        second = self.row(next_request)
        self.assertEqual(second['credit_charged'], 424000)
        self.assertEqual(json.loads(second['cost_details'])['amount'], '0.00212')
        self.assertEqual(json.loads(second['cost_details'])['currency'], 'CNY')
        self.assertEqual(self.row(request)['credit_charged'], 32000)

    def test_fixed_request_respects_whole_price_before_submission(self):
        self.policy['daily_credits'] = 1.999999
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('42', 'fixed-model', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'daily_credits_exhausted')
        with self.ledger.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM requests').fetchone()[0], 0)
        self.policy.update(daily_credits=100, global_daily_credits=2)
        request, _ = self.ledger.reserve('42', 'fixed-model', 1, 1, self.policy)
        self.ledger.finish(request, completed=True)
        with self.assertRaises(Rejected) as blocked:
            self.ledger.reserve('43', 'fixed-model', 1, 1, self.policy)
        self.assertEqual(blocked.exception.code, 'service_daily_credits_exhausted')

    def test_old_records_keep_unknown_currency_cost_and_legacy_credit(self):
        with self.ledger.connect() as db:
            db.execute('''INSERT INTO requests(id,forum_id,day,reserved,charged,state,model,created_at)
                VALUES('legacy','42',?,200,120,'charged','token-model',1)''', (calendar()[0],))
        self.ledger = Ledger(self.path)
        row = self.row('legacy')
        self.assertIsNone(row['billing_snapshot'])
        self.assertIsNone(row['cost_details'])
        self.assertEqual(row['credit_charged'], 120000)
        self.assertEqual(self.ledger.summary('42', self.policy)['creditsUsed'], 0.12)


class BillingSettingsCompatibility(unittest.TestCase):
    def test_missing_conversion_cannot_replace_saved_admin_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            current = billing_policy()
            manager = PublicSettings(current, directory)
            manager.save(validate_settings(manager.settings), catalog(current))
            path = Path(directory, 'public-settings.json')
            saved = path.read_bytes()
            bad = deepcopy(manager.settings)
            bad['billingConfig']['creditsPerUnit'] = None
            with self.assertRaises(ValueError):
                manager.save(validate_settings(bad), catalog(current))
            self.assertEqual(path.read_bytes(), saved)
            self.assertEqual(current['billing_config']['creditsPerUnit'], 100)

    def test_version_two_settings_keep_credit_limits_without_inventing_prices(self):
        with tempfile.TemporaryDirectory() as directory:
            current = billing_policy()
            current.pop('billing_config')
            settings = initial_settings(current)
            settings.pop('billingConfig')
            Path(directory, 'public-settings.json').write_text(json.dumps({
                'version': 2, 'settings': settings, 'models': current['models']}), encoding='utf8')
            manager = PublicSettings(current, directory)
            self.assertFalse(manager.configuration_error)
            self.assertEqual(manager.settings['billingConfig'], default_billing_config())
            self.assertEqual(manager.settings['dailyCredits'], 100)
            self.assertEqual(current['billing_config'], default_billing_config())
            models = public_models(current)
            self.assertTrue(all(model['billing']['mode'] == 'credits' for model in models))
            self.assertTrue(all(model['creditRate'] == default_rate() for model in models))

    def test_pre_billing_sqlite_schema_adds_only_nullable_cost_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'old.sqlite3')
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('''CREATE TABLE requests (id TEXT PRIMARY KEY,forum_id TEXT NOT NULL,
                    day TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL,model TEXT NOT NULL,created_at REAL NOT NULL,
                    credit_reserved INTEGER,credit_charged INTEGER,credit_rate TEXT,token_details TEXT)''')
                db.execute('''INSERT INTO requests VALUES('old','42',?,200,120,'charged','token-model',1,
                    200000,120000,?,NULL)''', (calendar()[0], json.dumps(default_rate())))
            ledger = Ledger(path)
            Ledger(path)
            with ledger.connect() as db:
                row = dict(db.execute("SELECT * FROM requests WHERE id='old'").fetchone())
            self.assertEqual((row['charged'], row['credit_charged']), (120, 120000))
            self.assertIsNone(row['billing_snapshot'])
            self.assertIsNone(row['cost_details'])


class BillingWebIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.policy = billing_policy()
        self.upstream_status = 200
        self.response_error = False
        self.partial_stream = False
        async def token(request):
            return web.json_response({'userId': 42, 'token': 'a' * 40})
        async def forum(request):
            return web.json_response({'data': {'type': 'users', 'id': '42', 'attributes': {
                'username': 'member', 'displayName': 'Member', 'email': 'member@example.invalid',
                'isAdmin': False, 'isEmailConfirmed': True, 'suspendedUntil': None}}})
        async def upstream(request):
            payload = await request.json()
            if self.upstream_status != 200:
                return web.json_response({'error': {'message': 'mock unavailable'}}, status=self.upstream_status)
            # Successful fixed-price output intentionally has no usage object.
            result = ({'error': {'message': 'mock semantic error'}} if self.response_error else
                      {'choices': [{'message': {'role': 'assistant', 'content': 'OK'}}]})
            if payload.get('stream'):
                response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
                await response.prepare(request)
                if self.partial_stream:
                    partial = {'choices': [{'delta': {'content': 'Partial output'}}]}
                    await response.write(('data: ' + json.dumps(partial) + '\n\n').encode())
                if not self.response_error:
                    result = {'choices': [{'delta': {'content': 'OK'}}]}
                await response.write(('data: ' + json.dumps(result) + '\n\ndata: [DONE]\n\n').encode())
                await response.write_eof()
                return response
            return web.json_response(result)
        remote = web.Application()
        remote.router.add_post('/api/token', token)
        remote.router.add_get('/api/users/{id}', forum)
        remote.router.add_post('/v1/chat/completions', upstream)
        self.remote = TestServer(remote)
        await self.remote.start_server()
        class Material:
            async def material(self, user):
                return 'private-fixture-material'
        base = str(self.remote.make_url('')).rstrip('/')
        self.client = TestClient(TestServer(create_app(self.policy, Path(self.temp.name) / 'ledger.sqlite3',
            forum=base, gateway=base, material_factory=lambda *args: Material())))
        await self.client.start_server()
        self.ledger = self.client.app['ledger']
        self.bearer = {'Authorization': 'Bearer lc1.42.' + 'a' * 40}

    async def asyncTearDown(self):
        await self.client.close()
        await self.remote.close()
        self.temp.cleanup()

    async def cookie(self):
        response = await self.client.post('/web/login', headers={'Origin': ORIGIN},
            json={'identification': 'member', 'password': 'fixture-password'})
        self.assertEqual(response.status, 200, await response.text())
        return {'Cookie': COOKIE + '=' + response.cookies[COOKIE].value}

    async def test_web_records_expose_own_saved_cost_and_leave_legacy_cost_unknown(self):
        cookie = await self.cookie()
        token, _ = self.ledger.reserve('42', 'token-model', 100, 20, self.policy)
        self.ledger.finish(token, billable_usage(), completed=True)
        fixed, _ = self.ledger.reserve('42', 'fixed-model', 100, 20, self.policy)
        self.ledger.finish(fixed, completed=True)
        old, _ = self.ledger.reserve('42', 'legacy-model', 100, 20, self.policy)
        self.ledger.finish(old, billable_usage(), completed=True)
        uncertain, _ = self.ledger.reserve('42', 'token-model', 100, 20, self.policy)
        self.ledger.finish(uncertain)
        private, _ = self.ledger.reserve('99', 'fixed-model', 100, 20, self.policy)
        self.ledger.finish(private, completed=True)
        response = await self.client.get('/web/usage', headers=cookie)
        self.assertEqual(response.status, 200)
        result = await response.json()
        records = {record['id']: record for record in result['records']}
        self.assertEqual(set(records), {token, fixed, old, uncertain})
        self.assertEqual(records[token]['credits'], 0.032)
        self.assertEqual(records[token]['costDetails']['amount'], '0.00032')
        self.assertEqual(records[token]['billing']['prices']['cacheRead'], 0.5)
        self.assertEqual(records[fixed]['tokens'], 0)
        self.assertEqual(records[fixed]['costDetails']['basis'], 'request')
        self.assertIsNone(records[old]['costDetails'])
        self.assertEqual(records[uncertain]['costDetails']['basis'], 'reservation')
        self.assertEqual(result['today']['credits'], 2.272)
        self.assertNotIn('private-fixture-material', json.dumps(result))
        self.assertNotIn('a' * 40, json.dumps(result))

    async def test_http_and_sse_success_without_usage_charge_fixed_request(self):
        for stream in (False, True):
            response = await self.client.post('/v1/chat/completions', headers=self.bearer,
                json={'model': 'fixed-model', 'messages': [{'role': 'user', 'content': 'Hi'}],
                      'max_tokens': 32, 'stream': stream})
            self.assertEqual(response.status, 200, await response.read())
            await response.read()
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual((summary['requestsUsed'], summary['tokensUsed'], summary['creditsUsed']), (2, 0, 4))
        with self.ledger.connect() as db:
            rows = db.execute('SELECT state,cost_details FROM requests').fetchall()
        self.assertTrue(all(row['state'] == 'charged' for row in rows))
        self.assertTrue(all(json.loads(row['cost_details'])['basis'] == 'request' for row in rows))

    async def test_non200_upstream_refunds_fixed_request(self):
        self.upstream_status = 503
        response = await self.client.post('/v1/chat/completions', headers=self.bearer,
            json={'model': 'fixed-model', 'messages': [{'role': 'user', 'content': 'Hi'}]})
        self.assertEqual(response.status, 503)
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual((summary['requestsUsed'], summary['creditsUsed'], summary['creditsReserved']), (0, 0, 0))
        with self.ledger.connect() as db:
            row = db.execute('SELECT state,cost_details FROM requests').fetchone()
        self.assertEqual(row['state'], 'released')
        self.assertIsNone(row['cost_details'])

    async def test_http200_explicit_error_refunds_instead_of_charging_fixed_price(self):
        self.response_error = True
        response = await self.client.post('/v1/chat/completions', headers=self.bearer,
            json={'model': 'fixed-model', 'messages': [{'role': 'user', 'content': 'Hi'}]})
        self.assertEqual(response.status, 503, await response.read())
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual((summary['requestsUsed'], summary['creditsUsed'], summary['creditsReserved']), (0, 0, 0))
        with self.ledger.connect() as db:
            row = db.execute('SELECT state,credit_charged,cost_details FROM requests').fetchone()
        self.assertEqual((row['state'], row['credit_charged'], row['cost_details']), ('released', 0, None))

    async def test_sse_error_refunds_without_output_and_keeps_partial_unknown_usage(self):
        self.response_error = True
        for partial in (False, True):
            self.partial_stream = partial
            for model in ('fixed-model', 'token-model'):
                with self.subTest(partial=partial, model=model):
                    response = await self.client.post('/v1/chat/completions', headers=self.bearer,
                        json={'model': model, 'stream': True, 'max_tokens': 32,
                              'messages': [{'role': 'user', 'content': 'Hi'}]})
                    body = await response.read()
                    self.assertEqual(response.status, 200, body)
                    self.assertIn(b'mock semantic error', body)
                    with self.ledger.connect() as db:
                        row = db.execute('SELECT * FROM requests ORDER BY rowid DESC LIMIT 1').fetchone()
                    if partial:
                        self.assertIn(b'Partial output', body)
                        self.assertEqual(row['state'], 'uncertain')
                        self.assertEqual(row['credit_charged'], row['credit_reserved'])
                        self.assertIsNone(row['token_details'])
                        money = json.loads(row['cost_details'])
                        self.assertEqual(money['basis'], 'request' if model == 'fixed-model' else 'reservation')
                    else:
                        self.assertEqual((row['state'], row['credit_charged']), ('released', 0))
                        self.assertIsNone(row['cost_details'])
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual(summary['requestsUsed'], 2)
        self.assertEqual(summary['creditsReserved'], 0)


if __name__ == '__main__':
    unittest.main()
