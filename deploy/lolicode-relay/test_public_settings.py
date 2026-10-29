"""Safe public-model settings; native admin and forum/model services are local mocks."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from bridge import Ledger, active_models, create_app
from public_settings import ORIGIN, PublicSettings, UPSTREAM_NAME, UPSTREAM_MARKER, catalog_model_metadata
from test_bridge import POLICY, USER


def native_channel(channel_id=1, **changes):
    return {'id': channel_id, 'name': 'My upstream', 'type': 1, 'status': 1,
            'group': 'default', 'base_url': 'https://upstream.invalid',
            'models': 'mock-model,new-model', 'key': 'private-upstream-secret', **changes}


class PublicSettingsHttp(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'public-settings.json'
        self.db = Path(self.temp.name) / 'ledger.sqlite3'
        self.admin = {'id': 1, 'username': 'admin', 'status': 1, 'role': 100}
        self.channel_rows = [native_channel(), native_channel(2, type=57),
                             native_channel(3, status=2), native_channel(4, group='private'),
                             native_channel(5, type=8, base_url='https://example.invalid/not-chat')]
        self.native_calls = []
        self.model_calls = 0
        self.test_calls = []
        self.test_success = True
        self.mutations = []
        self.fail_promotion = False
        self.catalog_calls = []
        self.catalog_urls = []
        self.catalog_payload = {'data': [{'id': 'catalog-model', 'name': 'Catalog model'}]}
        self.catalog_handler = None

        async def user(request):
            self.native_calls.append(request.path)
            if request.headers.get('Authorization') != 'Bearer native-admin-token':
                return web.json_response({'success': False}, status=401)
            return web.json_response({'success': True, 'data': self.admin})

        async def channels(request):
            self.native_calls.append(request.path)
            self.assertEqual(request.headers.get('Authorization'), 'Bearer native-admin-token')
            offset = int(request.query['p']) * int(request.query['page_size'])
            return web.json_response({'success': True, 'data': {
                'items': self.channel_rows[offset:offset + 50], 'total': len(self.channel_rows)}})

        async def model(request):
            self.model_calls += 1
            return web.json_response({})

        async def mutate_channel(request):
            self.assertEqual(request.headers.get('Authorization'), 'Bearer native-admin-token')
            body = await request.json()
            if request.method == 'POST':
                row = deepcopy(body['channel'])
                row['id'] = max([99] + [channel['id'] for channel in self.channel_rows]) + 1
                self.channel_rows.append(row)
                self.mutations.append(('create', row['id']))
            else:
                row = next(channel for channel in self.channel_rows if channel['id'] == body['id'])
                if self.fail_promotion and body.get('name') == UPSTREAM_NAME:
                    return web.json_response({'success': False, 'message': 'private-upstream-secret'})
                row.update(body)
                self.mutations.append(('update', row['id']))
            return web.json_response({'success': True})

        async def mutate_status(request):
            body = await request.json()
            row = next(channel for channel in self.channel_rows if channel['id'] == int(request.match_info['id']))
            row['status'] = body['status']
            self.mutations.append(('status', row['id'], body['status']))
            return web.json_response({'success': True})

        async def test_channel(request):
            self.test_calls.append((int(request.match_info['id']), request.query['model']))
            return web.json_response({'success': self.test_success, 'message': 'private-upstream-secret'})

        async def catalog(request):
            self.catalog_calls.append({'path': request.path, 'query': dict(request.query),
                                       'headers': dict(request.headers)})
            if self.catalog_handler is not None:
                return await self.catalog_handler(request)
            return web.json_response(self.catalog_payload)

        upstream = web.Application()
        upstream.router.add_get('/api/user/self', user)
        upstream.router.add_get('/api/channel/', channels)
        upstream.router.add_post('/api/channel/', mutate_channel)
        upstream.router.add_put('/api/channel/', mutate_channel)
        upstream.router.add_post('/api/channel/{id}/status', mutate_status)
        upstream.router.add_get('/api/channel/test/{id}', test_channel)
        upstream.router.add_post('/v1/chat/completions', model)
        upstream.router.add_get('/{tail:.*}', catalog)
        self.remote = TestServer(upstream)
        await self.remote.start_server()
        self.base = str(self.remote.make_url('')).rstrip('/')

        class Material:
            async def material(self, identity):
                return 'fixture-internal-key'

        self.policy = deepcopy(POLICY)
        self.policy['models'][0]['name'] = 'Known model'
        self.policy['models'][0]['contextLimit'] = 65536
        self.policy['models'][0]['supportsTools'] = False
        self.policy['models'][0]['protocol'] = 'openai_chat'
        self.policy['available_until'] = '2026-10-21T13:22:23+00:00'
        self.client = TestClient(TestServer(create_app(self.policy, self.db, gateway=self.base,
            material_factory=lambda *args: Material())))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer native-admin-token', 'Origin': ORIGIN}
        self.url = '/admin/public-settings'

        owner = self

        class MappedCatalogSession:
            async def __aenter__(self):
                self.client = aiohttp.ClientSession()
                return self

            async def __aexit__(self, *_args):
                await self.client.close()

            def get(self, url, **kwargs):
                from urllib.parse import urlsplit
                parsed = urlsplit(url)
                owner.catalog_urls.append(url)
                return self.client.get(owner.base + parsed.path + ('?' + parsed.query if parsed.query else ''), **kwargs)

        self.catalog_session = MappedCatalogSession

    async def asyncTearDown(self):
        await self.client.close()
        await self.remote.close()
        self.temp.cleanup()

    async def read(self):
        response = await self.client.get(self.url, headers=self.headers)
        self.assertEqual(response.status, 200)
        return await response.json()

    async def save(self, settings, status=200, headers=None):
        response = await self.client.put(self.url, json=settings, headers=headers or self.headers)
        result = await response.json()
        self.assertEqual(response.status, status, result)
        return result

    async def test_admin_authentication_and_channel_allowlist_are_isolated(self):
        response = await self.client.get(self.url)
        self.assertEqual(response.status, 401)
        self.assertEqual(self.native_calls, [])
        for change in ({'role': 1}, {'id': 0}, {'id': 'admin'}, {'status': 2}):
            original = self.admin
            self.admin = {**original, **change}
            response = await self.client.get(self.url, headers=self.headers)
            self.assertEqual(response.status, 403)
            self.admin = original
        result = await self.read()
        self.assertEqual([channel['id'] for channel in result['channels']], [1])
        self.assertEqual(result['settings']['revision'], 0)
        self.assertTrue(result['status']['expired'])
        self.assertFalse(result['status']['ready'])
        encoded = json.dumps(result)
        self.assertNotIn('private-upstream-secret', encoded)
        self.assertNotIn('native-admin-token', encoded)
        self.assertNotIn('base_url', encoded)
        self.assertEqual(result['channels'][0]['baseUrl'], 'https://upstream.invalid/v1')
        self.assertFalse(result['channels'][0]['managed'])
        self.assertEqual(self.model_calls, 0)

    async def test_origin_invalid_fields_and_models_never_write(self):
        settings = (await self.read())['settings']
        settings.update(enabled=True, availabilityMode='permanent', availableUntil=None)
        await self.save(settings, 403, {**self.headers, 'Origin': 'https://hostile.invalid'})
        for changes in ({'apiKey': 'do-not-save'}, {'dailyRequests': True}, {'maxRequestBytes': 3 * 1024**2 + 1},
                        {'availabilityMode': 'permanent', 'availableUntil': '2999-01-01T00:00:00Z'},
                        {'availabilityMode': 'until', 'availableUntil': '2999-01-01T00:00:00'},
                        {'modelIds': ['mock-model,new-model']}, {'modelIds': ['mock model']},
                        {'modelIds': ['new-model', 'new-model']}, {'modelIds': []}):
            await self.save({**settings, **changes}, 400)
            self.assertFalse(self.path.exists())
        result = await self.save({**settings, 'modelIds': ['not-in-enabled-channel']}, 400)
        self.assertEqual(result['error']['code'], 'model_unavailable')
        self.assertFalse(self.path.exists())
        response = await self.client.put(self.url, data=b' ' * 65537,
            headers={**self.headers, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 413)
        self.assertFalse(self.path.exists())

    async def test_permanent_publish_preserves_capability_usage_and_restart(self):
        ledger = self.client.app['ledger']
        ledger.account(USER)
        request_id, _ = ledger.reserve('42', 'mock-model', 100, 200,
            {**POLICY, 'models': POLICY['models']})
        ledger.finish(request_id, 130)
        before = ledger.summary('42', self.policy)
        settings = (await self.read())['settings']
        settings.update(enabled=True, availabilityMode='permanent', availableUntil=None,
                        modelIds=['mock-model', 'new-model'])
        result = await self.save(settings)
        self.assertTrue(result['status']['ready'])
        self.assertEqual(result['settings']['revision'], 1)
        self.assertNotIn('available_until', self.policy)
        self.assertEqual(self.policy['models'][0]['contextLimit'], 65536)
        self.assertIs(self.policy['models'][0]['supportsTools'], False)
        self.assertEqual(self.policy['models'][1], {'id': 'new-model', 'name': 'new-model',
            'contextLimit': 1000000, 'outputLimit': 32000, 'supportsTools': True,
            'inputModalities': ['text'], 'protocol': 'openai_chat'})
        after = ledger.summary('42', self.policy)
        self.assertEqual(after['requestsUsed'], before['requestsUsed'])
        self.assertEqual(after['tokensUsed'], before['tokensUsed'])
        restarted_policy = deepcopy(POLICY)
        manager = PublicSettings(restarted_policy, self.temp.name)
        self.assertEqual(manager.settings, result['settings'])
        self.assertEqual(restarted_policy['models'], self.policy['models'])
        self.assertEqual(self.model_calls, 0)
        self.assertEqual(len(list(Path(self.temp.name).glob('.public-settings-*'))), 0)

    async def test_revision_and_atomic_failure_keep_saved_settings(self):
        settings = (await self.read())['settings']
        settings.update(enabled=True, availabilityMode='permanent', availableUntil=None)
        result = await self.save(settings)
        saved = self.path.read_bytes()
        stale = await self.save(settings, 409)
        self.assertEqual(stale['error']['code'], 'settings_conflict')
        self.assertEqual(self.path.read_bytes(), saved)
        settings = {**result['settings'], 'dailyRequests': 40}
        with patch('public_settings.os.replace', side_effect=OSError('private-path-do-not-leak')):
            failure = await self.save(settings, 503)
        self.assertEqual(failure['error']['code'], 'settings_write_failed')
        self.assertNotIn('private-path-do-not-leak', json.dumps(failure))
        self.assertEqual(self.path.read_bytes(), saved)
        self.assertEqual((await self.read())['settings']['dailyRequests'], 20)
        self.assertEqual(len(list(Path(self.temp.name).glob('.public-settings-*'))), 0)

    async def test_close_retains_selection_then_reopens_until_deadline(self):
        settings = (await self.read())['settings']
        settings.update(enabled=False, availabilityMode='permanent', availableUntil=None)
        closed = await self.save(settings)
        self.assertEqual(active_models(self.policy), [])
        self.assertEqual(closed['settings']['modelIds'], ['mock-model'])
        manager = PublicSettings(deepcopy(POLICY), self.temp.name)
        self.assertFalse(manager.settings['enabled'])
        self.assertEqual(manager.settings['modelIds'], ['mock-model'])
        end = datetime.now(timezone.utc) + timedelta(hours=2)
        reopened = await self.save({**closed['settings'], 'enabled': True,
            'availabilityMode': 'until', 'availableUntil': end.isoformat()})
        self.assertTrue(reopened['status']['ready'])
        self.assertEqual(active_models(self.policy, end), [])

    async def test_enabled_custom_chat_channels_and_pagination(self):
        self.channel_rows = [native_channel(index, status=2) for index in range(1, 52)]
        self.channel_rows.append(native_channel(52, type=8,
            base_url='https://upstream.invalid/v1/chat/completions'))
        result = await self.read()
        self.assertEqual([channel['id'] for channel in result['channels']], [52])
        self.channel_rows = [native_channel(models=','.join('model-' + str(i) for i in range(2049)))]
        response = await self.client.get(self.url, headers=self.headers)
        self.assertEqual(response.status, 503)
        self.assertFalse(self.path.exists())

    async def post_upstream(self, body, expected=200, headers=None):
        response = await self.client.post('/admin/upstream', json=body, headers=headers or self.headers)
        result = await response.json()
        self.assertEqual(response.status, expected, result)
        self.assertNotIn('private-upstream-secret', json.dumps(result))
        self.assertNotIn('new-api-secret', json.dumps(result))
        return result

    async def test_simple_upstream_requires_admin_origin_and_public_https(self):
        body = {'baseUrl': 'https://example.com/v1', 'apiKey': 'new-api-secret', 'modelIds': ['mock-model']}
        await self.post_upstream(body, 401, {'Origin': ORIGIN})
        await self.post_upstream(body, 403, {**self.headers, 'Origin': 'https://hostile.invalid'})
        for url in ('http://example.com/v1', 'https://key@example.com', 'https://example.com/v1?token=secret',
                    'https://example.com/v1#secret', 'https://example.com:8443/v1', 'https://example.com\\@hostile.invalid'):
            await self.post_upstream({**body, 'baseUrl': url}, 400)
        with patch('public_settings.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            await self.post_upstream(body, 400)
        with patch('public_settings.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('169.254.169.254', 443))]):
            await self.post_upstream(body, 400)
        for model in ('a,b', 'a b', 'a\tb', 'a\u2003b'):
            await self.post_upstream({**body, 'modelIds': [model]}, 400)
        with patch('public_settings.check_public_host'):
            await self.post_upstream({**body, 'modelIds': [body['apiKey']]}, 400)
            await self.post_upstream({**body, 'presetId': body['apiKey']}, 400)
            await self.post_upstream({**body, 'apiKey': 'secret-\u00e9'}, 400)
        self.assertEqual(self.mutations, [])
        self.assertEqual(self.test_calls, [])

    async def test_successful_upstream_is_higher_priority_and_old_key_is_preserved(self):
        old = native_channel(10, name=UPSTREAM_NAME, type=8, remark=UPSTREAM_MARKER,
            base_url='https://previous.invalid/v1/chat/completions', key='old-secret', priority=9)
        unrelated = native_channel(11, name='Expired GLM', priority=12)
        self.channel_rows = [old, unrelated]
        before_policy = deepcopy(self.policy)
        with patch('public_settings.check_public_host'):
            result = await self.post_upstream({'baseUrl': 'https://example.com/v1',
                'apiKey': 'new-api-secret', 'modelIds': ['mock-model', 'new-model'], 'revision': 0, 'channelId': 10})
        self.assertTrue(result['success'])
        self.assertEqual(len(self.test_calls), 1)
        self.assertEqual(self.test_calls[0][1], 'mock-model')
        replacement = next(channel for channel in self.channel_rows if channel['id'] == result['channel']['id'])
        self.assertEqual(replacement['base_url'], 'https://example.com/v1/chat/completions')
        self.assertEqual(replacement['priority'], 13)
        self.assertEqual(replacement['status'], 1)
        self.assertEqual(old['key'], 'old-secret')
        self.assertEqual(old['status'], 2)
        self.assertIn('backup', old['name'])
        enabled_at = self.mutations.index(('status', replacement['id'], 1))
        disabled_at = self.mutations.index(('status', old['id'], 2))
        self.assertLess(enabled_at, disabled_at)
        self.assertEqual(unrelated['status'], 1)
        self.assertEqual(unrelated['priority'], 12)
        self.assertEqual(self.policy, before_policy)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.model_calls, 0)

    async def test_failed_upstream_test_or_promotion_keeps_previous_working_source(self):
        old = native_channel(10, name=UPSTREAM_NAME, type=8, remark=UPSTREAM_MARKER,
            base_url='https://previous.invalid/v1/chat/completions', key='old-secret')
        self.channel_rows = [old]
        body = {'baseUrl': 'https://example.com', 'apiKey': 'new-api-secret', 'modelIds': ['mock-model'], 'channelId': 10}
        self.test_success = False
        with patch('public_settings.check_public_host'):
            result = await self.post_upstream(body)
        self.assertFalse(result['success'])
        self.assertEqual(old['status'], 1)
        self.assertEqual(old['name'], UPSTREAM_NAME)
        self.assertEqual(self.channel_rows[-1]['status'], 2)
        self.assertFalse(self.path.exists())
        self.test_success = True
        self.fail_promotion = True
        with patch('public_settings.check_public_host'):
            result = await self.post_upstream(body, 503)
        self.assertEqual(result['error']['code'], 'upstream_activation_failed')
        self.assertEqual(old['status'], 1)
        self.assertEqual(old['key'], 'old-secret')
        self.assertEqual(old['name'], UPSTREAM_NAME)
        self.assertEqual(self.channel_rows[-1]['status'], 2)

    async def discover(self, body=None, expected=200, headers=None):
        body = body if body is not None else {'baseUrl': 'https://catalog.example/v1',
            'apiKey': 'catalog-key-do-not-leak', 'protocol': 'openai_chat'}
        with patch('public_settings.check_public_host'), patch('public_settings.catalog_session', self.catalog_session):
            response = await self.client.post('/admin/upstream/models', json=body, headers=headers or self.headers)
            result = await response.json()
        self.assertEqual(response.status, expected, result)
        self.assertNotIn('catalog-key-do-not-leak', json.dumps(result))
        self.assertEqual(self.mutations, [])
        self.assertEqual(self.test_calls, [])
        self.assertFalse(self.path.exists())
        return result

    async def test_discovery_protocol_headers_and_versioned_urls_use_real_local_gets(self):
        cases = [
            ('openai_chat', 'https://catalog.example', '/v1/models', 'Authorization', 'Bearer catalog-key-do-not-leak'),
            ('openai_responses', 'https://catalog.example/service/v1/responses', '/service/v1/models', 'Authorization', 'Bearer catalog-key-do-not-leak'),
            ('anthropic', 'https://catalog.example/anthropic/v1/messages', '/anthropic/v1/models', 'x-api-key', 'catalog-key-do-not-leak'),
            ('gemini_native', 'https://catalog.example/proxy/v1beta', '/proxy/v1beta/models', 'x-goog-api-key', 'catalog-key-do-not-leak'),
        ]
        for protocol, base, path, header, secret in cases:
            if protocol == 'gemini_native':
                self.catalog_payload = {'models': [{'name': 'models/gemini-test', 'displayName': 'Gemini test'}]}
            else:
                self.catalog_payload = {'data': [{'id': 'catalog-model', 'name': 'Catalog model'}]}
            result = await self.discover({'baseUrl': base, 'apiKey': 'catalog-key-do-not-leak',
                                          'protocol': protocol, 'presetId': 'test-preset'})
            call = self.catalog_calls[-1]
            self.assertEqual(call['path'], path)
            self.assertEqual(call['headers'][header], secret)
            if protocol == 'anthropic':
                self.assertEqual(call['headers']['anthropic-version'], '2023-06-01')
            if protocol in ('anthropic', 'gemini_native'):
                self.assertNotIn('Authorization', call['headers'])
            self.assertEqual(result['protocol'], protocol)
            self.assertEqual(result['baseUrl'] + '/models', 'https://catalog.example' + path)
            self.assertEqual(result['models'][0]['id'], 'gemini-test' if protocol == 'gemini_native' else 'catalog-model')
        self.assertTrue(all('catalog-key-do-not-leak' not in url for url in self.catalog_urls))

    async def test_fetched_context_choices_follow_source_publish_and_restart(self):
        self.catalog_payload = {'data': [{'id': 'catalog-model', 'name': 'Named model',
            'context_window': 128000, 'context_windows': [1000000, 128000],
            'max_output_tokens': 8192, 'api_key': 'upstream-secret-never-publish'}]}
        discovered = await self.discover()
        self.assertEqual(discovered['models'][0]['contextLimits'], [128000, 1000000])
        source = {'baseUrl': 'https://catalog.example/v1', 'apiKey': 'catalog-key-do-not-leak',
                  'protocol': 'openai_chat', 'modelIds': ['catalog-model']}
        with patch('public_settings.check_public_host'):
            saved = await self.post_upstream(source)
        self.assertEqual(saved['channel']['models'][0]['contextLimit'], 128000)
        settings = (await self.read())['settings']
        settings.update(enabled=True, availabilityMode='permanent', availableUntil=None,
                        modelIds=['catalog-model'])
        await self.save(settings)
        self.assertEqual(self.policy['models'][0]['contextLimits'], [128000, 1000000])
        self.assertEqual(self.policy['models'][0]['name'], 'Named model')
        restarted = PublicSettings(deepcopy(POLICY), self.temp.name)
        self.assertEqual(restarted.policy['models'][0]['contextLimit'], 128000)
        self.assertEqual(restarted.policy['models'][0]['contextLimits'], [128000, 1000000])
        self.assertNotIn('upstream-secret-never-publish', self.path.read_text())
        self.assertNotIn('catalog-key-do-not-leak', self.path.read_text())
        self.assertEqual(self.model_calls, 0)

    async def test_context_cache_is_bound_to_credentials_url_protocol_and_expiry(self):
        self.catalog_payload = {'data': [{'id': 'catalog-model', 'context_windows': [128000, 1000000]}]}
        with patch('public_settings.monotonic', return_value=1000):
            await self.discover()
        source = {'baseUrl': 'https://catalog.example/v1', 'apiKey': 'catalog-key-do-not-leak',
                  'protocol': 'openai_chat', 'modelIds': ['catalog-model']}
        changes = [{'apiKey': 'different-secret'}, {'baseUrl': 'https://other.example/v1'},
                   {'protocol': 'openai_responses'}, {}]
        for index, change in enumerate(changes):
            clock = 1601 if not change else 1001
            with patch('public_settings.check_public_host'), patch('public_settings.monotonic', return_value=clock):
                saved = await self.post_upstream({**source, **change, 'name': 'Separate ' + str(index)})
            self.assertNotIn('contextLimits', saved['channel']['models'][0])


    async def test_discovery_follows_advertised_pages_and_deduplicates(self):
        async def pages(request):
            if request.query.get('after_id') == 'one':
                return web.json_response({'data': [{'id': 'two', 'display_name': 'Second'}, {'id': 'one'}], 'has_more': False})
            return web.json_response({'data': [{'id': 'one', 'name': 'First'}], 'has_more': True, 'last_id': 'one'})
        self.catalog_handler = pages
        result = await self.discover({'baseUrl': 'https://catalog.example',
            'apiKey': 'catalog-key-do-not-leak', 'protocol': 'anthropic'})
        self.assertEqual(result['models'], [{'id': 'one', 'name': 'First'}, {'id': 'two', 'name': 'Second'}])
        self.assertEqual(self.catalog_calls[-1]['query'], {'after_id': 'one'})

        async def gemini_pages(request):
            if request.query.get('pageToken') == 'next-page':
                return web.json_response({'models': [{'name': 'models/two', 'displayName': 'Second'}]})
            return web.json_response({'models': [{'name': 'models/one'}], 'nextPageToken': 'next-page'})
        self.catalog_handler = gemini_pages
        result = await self.discover({'baseUrl': 'https://catalog.example/v1',
            'apiKey': 'catalog-key-do-not-leak', 'protocol': 'gemini_native'})
        self.assertEqual([model['id'] for model in result['models']], ['one', 'two'])
        self.assertEqual(self.catalog_calls[-1]['path'], '/v1/models')
        self.catalog_handler = None
        self.catalog_payload = {'models': [
            {'name': 'models/embedding-only', 'supportedGenerationMethods': ['embedContent']},
            {'name': 'models/generator', 'supportedGenerationMethods': ['generateContent']},
            {'name': 'models/unknown-capability'},
        ]}
        result = await self.discover({'baseUrl': 'https://catalog.example/v1beta',
            'apiKey': 'catalog-key-do-not-leak', 'protocol': 'gemini_native'})
        self.assertEqual([model['id'] for model in result['models']], ['generator', 'unknown-capability'])

    async def test_discovery_never_redirects_or_forwards_key_to_pagination_host(self):
        async def redirect(_request):
            raise web.HTTPFound('https://hostile.invalid/steal')
        self.catalog_handler = redirect
        result = await self.discover(expected=400)
        self.assertEqual(result['error']['code'], 'catalog_redirect_rejected')
        self.assertEqual(len(self.catalog_calls), 1)
        self.catalog_handler = None
        self.catalog_payload = {'data': [{'id': 'safe'}], 'next': 'https://hostile.invalid/v1/models'}
        result = await self.discover(expected=400)
        self.assertEqual(result['error']['code'], 'catalog_pagination_invalid')
        self.assertEqual(len(self.catalog_calls), 2)
        self.catalog_payload = {'data': [{'id': 'safe'}, {'id': 'catalog-key-do-not-leak'}],
                                'next': None}
        self.catalog_payload['data'][0]['name'] = 'Echo catalog-key-do-not-leak'
        result = await self.discover()
        self.assertEqual(result['models'], [{'id': 'safe', 'name': 'Echo [redacted]'}])

    async def test_discovery_limits_and_isolation_do_not_write(self):
        await self.discover(expected=401, headers={'Origin': ORIGIN})
        await self.discover(expected=403, headers={**self.headers, 'Origin': 'https://hostile.invalid'})
        await self.discover({'baseUrl': 'http://catalog.example', 'apiKey': 'catalog-key-do-not-leak'}, expected=400)
        self.assertEqual(self.catalog_calls, [])
        self.catalog_payload = {'data': [{'id': 'model-' + str(index)} for index in range(2049)]}
        result = await self.discover(expected=400)
        self.assertEqual(result['error']['code'], 'catalog_too_large')
        self.catalog_payload = {'data': [{'id': 'safe'}], 'has_more': True}
        result = await self.discover(expected=400)
        self.assertEqual(result['error']['code'], 'catalog_pagination_invalid')
        self.catalog_payload = {'data': [{'id': 'new-response'}]}
        result = await self.discover()
        self.assertEqual(result['models'], [{'id': 'new-response', 'name': 'new-response'}])
        self.assertEqual((await self.read())['settings']['revision'], 0)

    async def test_discovery_blocks_literal_private_hosts_before_http(self):
        before = len(self.catalog_calls)
        for host in ('127.0.0.1', '169.254.169.254', '[::1]'):
            result = await self.discover({'baseUrl': 'https://' + host,
                'apiKey': 'catalog-key-do-not-leak'}, expected=400)
            self.assertEqual(result['error']['code'], 'invalid_upstream')
        self.assertEqual(len(self.catalog_calls), before)

    async def test_catalog_more_than_public_selection_limit_and_native_default_urls(self):
        self.channel_rows = [native_channel(1, models=','.join('a-' + str(index) for index in range(80))),
                             native_channel(2, models=','.join('b-' + str(index) for index in range(80))),
                             native_channel(3, base_url='', models='gpt-test')]
        result = await self.read()
        self.assertEqual(sum(len(channel['models']) for channel in result['channels']), 161)
        self.assertEqual(result['channels'][-1]['baseUrl'], 'https://api.openai.com/v1')
        settings = result['settings']
        settings.update(enabled=True, availabilityMode='permanent', availableUntil=None,
                        modelIds=[model['id'] for channel in result['channels'] for model in channel['models']])
        await self.save(settings, 400)

    async def test_multiple_managed_sources_edit_identity_and_native_protocols(self):
        first = {'baseUrl': 'https://example.com/v1', 'apiKey': 'new-api-secret',
                 'modelIds': ['mock-model'], 'name': 'Provider A', 'presetId': 'provider-a',
                 'protocol': 'openai_responses'}
        with patch('public_settings.check_public_host'):
            a = await self.post_upstream(first)
            b = await self.post_upstream({**first, 'baseUrl': 'https://anthropic.example/proxy/v1',
                                         'name': 'Provider B', 'protocol': 'anthropic'})
            c = await self.post_upstream({**first, 'baseUrl': 'https://gemini.example/v1beta',
                                         'name': 'Provider C', 'protocol': 'gemini_native'})
        rows = {row['id']: row for row in self.channel_rows}
        self.assertEqual(rows[a['channel']['id']]['type'], 8)
        self.assertEqual(a['effectiveProtocol'], 'openai_chat')
        self.assertIn('Chat Completions', a['message'])
        self.assertEqual(rows[b['channel']['id']]['type'], 14)
        self.assertEqual(rows[b['channel']['id']]['base_url'], 'https://anthropic.example/proxy')
        self.assertEqual(rows[c['channel']['id']]['type'], 24)
        self.assertEqual(rows[c['channel']['id']]['base_url'], 'https://gemini.example')
        self.assertTrue(all(rows[result['channel']['id']]['status'] == 1 for result in [a, b, c]))
        result = await self.read()
        self.assertEqual(len([channel for channel in result['channels'] if channel['managed']]), 3)
        self.assertTrue(all('private-upstream-secret' not in json.dumps(channel) for channel in result['channels']))
        with patch('public_settings.check_public_host'):
            edited = await self.post_upstream({**first, 'channelId': a['channel']['id'], 'name': 'Provider A renamed'})
        self.assertEqual(edited['channel']['name'], 'Provider A renamed')
        self.assertEqual(rows[a['channel']['id']]['status'], 2)
        self.assertEqual(rows[b['channel']['id']]['status'], 1)
        with patch('public_settings.check_public_host'):
            await self.post_upstream({**first, 'channelId': 1}, 409)
            original = deepcopy(rows[b['channel']['id']])
            conflict = await self.post_upstream({**first, 'name': 'Provider B'}, 409)
            self.assertEqual(conflict['error']['code'], 'channel_name_conflict')
            self.assertEqual(rows[b['channel']['id']], original)
            conflict = await self.post_upstream({**first, 'channelId': edited['channel']['id'],
                                                 'name': 'Provider B'}, 409)
            self.assertEqual(conflict['error']['code'], 'channel_name_conflict')
            self.assertEqual(rows[b['channel']['id']], original)
            failure = await self.post_upstream({**first, 'protocol': 'gemini_native',
                'baseUrl': 'https://gemini.example/v1'}, 400)
        self.assertEqual(failure['error']['code'], 'unsupported_upstream_version')


class ModelContextMetadata(unittest.TestCase):
    def test_explicit_aliases_and_choices_are_normalized_without_fabrication(self):
        for entry in ({'context_window': {'default': 128000, 'options': [128000, '1000000']}},
                      {'contextLimit': 128000, 'contextLimits': [1000000, 128000, 128000]},
                      {'context_length': 128000, 'parameters': {'context_window': {'enum': [128000, 1000000]}}}):
            self.assertEqual(catalog_model_metadata(entry),
                             {'contextLimit': 128000, 'contextLimits': [128000, 1000000]})
        self.assertEqual(catalog_model_metadata({'id': 'large-1m'}), {})
        self.assertEqual(catalog_model_metadata({'max_input_tokens': 32000}), {'contextLimit': 32000})
        self.assertEqual(catalog_model_metadata({'model_info': {'context_window': 128000,
            'context_limits': [128000, 1000000], 'api_key': 'must-not-escape'}}),
            {'contextLimit': 128000, 'contextLimits': [128000, 1000000]})
        self.assertEqual(catalog_model_metadata({'contextLimits': [True, 0, -1, 'bad', 1.5]}), {})

    def test_billing_tiers_remain_explicit_and_oversized_enums_are_rejected(self):
        self.assertEqual(catalog_model_metadata({'context_window': 1000000,
            'billing': {'token_prices': {'default': {'max_prompt_tokens': 128000},
                                         'long_context': {'max_prompt_tokens': 1000000}}}}),
            {'contextLimit': 128000, 'contextLimits': [128000, 1000000]})
        with self.assertRaises(ValueError):
            catalog_model_metadata({'contextLimits': list(range(1, 66))})


if __name__ == '__main__':
    unittest.main()
