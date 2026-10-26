#!/usr/bin/env python3
"""Real forum login + New API + temporary local mock; never calls a paid model."""
import asyncio
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid

import aiohttp
from aiohttp.test_utils import TestClient, TestServer
from bootstrap import Dashboard, ROOT
from bridge import Ledger, create_app
from backup import COMPOSE


def fixture(action, name, **fields):
    code = (ROOT / 'forum_fixture.php').read_text().removeprefix('<?php')
    result = subprocess.run(['runuser', '-u', 'www-data', '--', 'php', '-r', code],
                            input=json.dumps({'action': action, 'name': name, **fields}).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
    return json.loads(result.stdout)


async def main():
    dashboard = Dashboard()
    dashboard.login()
    assert dashboard.request('/api/channel/')['total'] == 0, 'Only run before real upstreams are configured'
    assert json.loads((ROOT / 'bridge-policy.json').read_text())['models'] == [], 'Do not disturb an open catalog'
    name = 'relaytest' + uuid.uuid4().hex[:12]
    password = uuid.uuid4().hex + 'Lc!'
    user = fixture('create', name, password=password)
    user_id = user['id']
    channel_id = None
    gateway_id = None
    gateway = subprocess.check_output(['docker', 'network', 'inspect', 'lolicode-relay_relay',
        '--format', '{{(index .IPAM.Config 0).Gateway}}']).decode().strip()
    mock_key = uuid.uuid4().hex
    calls = {'count': 0}

    class Mock(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            assert self.headers.get('Authorization') == 'Bearer ' + mock_key
            value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls['count'] += 1
            usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}
            message = {'role': 'assistant', 'content': 'bridge-verification-ok'}
            common = {'id': 'chatcmpl-bridge-test', 'model': 'gpt-4o-mini', 'created': int(time.time())}
            if value.get('stream'):
                chunks = [{'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'bridge-verification-ok'}, 'finish_reason': None}]},
                          {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}, {'choices': [], 'usage': usage}]
                body = ''.join('data: ' + json.dumps({**common, 'object': 'chat.completion.chunk', **chunk}) + '\n\n' for chunk in chunks)
                body += 'data: [DONE]\n\n'
                mime = 'text/event-stream'
            else:
                body = json.dumps({**common, 'object': 'chat.completion', 'usage': usage,
                    'choices': [{'index': 0, 'message': message, 'finish_reason': 'stop'}]})
                mime = 'application/json'
            encoded = body.encode()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer((gateway, 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {'timestamp': datetime.now(timezone.utc).isoformat(), 'paid_requests': 0}
    try:
        async with aiohttp.ClientSession() as http:
            async with http.post('https://lolicode.com/api/token',
                    json={'identification': name, 'password': password, 'remember': True}) as response:
                assert response.status == 200, 'Existing forum login rejected fixture'
                login = await response.json()
            assert str(login['userId']) == user_id
            headers = {'Authorization': 'Bearer lc1.' + user_id + '.' + login['token']}
            async with http.get('https://lolicode.com/relay/account', headers=headers) as response:
                result = await response.json()
                assert response.status == 200, ('Public account linkage failed', response.status, result)
            assert result['account']['id'] == user_id
            assert result['quota']['requestLimit'] == 20 and result['quota']['tokenLimit'] == 100000
            assert result['quota']['requestsUsed'] == 0
            assert 'email' not in result['account'] and 'gateway_key' not in json.dumps(result)
            report['original_forum_login_and_public_linkage'] = True
            ledger = Ledger(ROOT / 'bridge-state/bridge.sqlite3')
            with ledger.connect() as db:
                material = dict(db.execute('SELECT * FROM accounts WHERE forum_id=?', (user_id,)).fetchone())
            gateway_id, internal_key = material['gateway_id'], material['gateway_key']
            mirror = dashboard.request('/api/user/' + str(gateway_id))
            assert mirror['role'] == 1 and mirror['quota'] == 50000000
            report['mapped_to_normal_gateway_user'] = True
            test_name = 'bridge-verify-' + uuid.uuid4().hex[:12]
            dashboard.request('/api/channel/', {'mode': 'single', 'channel': {
                'name': test_name, 'type': 1, 'key': mock_key, 'status': 1,
                'models': 'gpt-4o-mini', 'group': 'default', 'base_url': 'http://' + gateway + ':' + str(server.server_port)}})
            matches = [c for c in dashboard.request('/api/channel/')['items'] if c['name'] == test_name]
            assert len(matches) == 1
            channel_id = matches[0]['id']

            class Material:
                async def material(self, identity):
                    assert identity['id'] == user_id
                    return internal_key

            policy = json.loads((ROOT / 'bridge-policy.json').read_text())
            policy['models'] = [{'id': 'gpt-4o-mini', 'contextLimit': 32768, 'outputLimit': 4096}]
            payload = {'model': 'gpt-4o-mini', 'messages': [{'role': 'user', 'content': 'bridge test'}], 'max_tokens': 32}
            with tempfile.TemporaryDirectory(prefix='bridge-verify-', dir=ROOT / 'bridge-state') as folder:
                client = TestClient(TestServer(create_app(policy, Path(folder) / 'ledger.sqlite3',
                    material_factory=lambda *args: Material())))
                await client.start_server()
                try:
                    # Wait on New API's channel-routing cache without charging a fixture day.
                    for attempt in range(20):
                        async with http.post('http://127.0.0.1:13000/v1/chat/completions', json=payload,
                                headers={'Authorization': 'Bearer ' + internal_key}) as response:
                            if response.status == 200:
                                await response.read()
                                break
                        await asyncio.sleep(2)
                    else:
                        raise AssertionError('Mock channel did not become available')
                    for index in range(20):
                        response = await client.post('/v1/chat/completions',
                            json={**payload, 'stream': index == 0}, headers=headers)
                        body = await response.read()
                        assert response.status == 200, ('Real forwarding failed', response.status, body[:200])
                        if index == 0:
                            assert b'[DONE]' in body
                    response = await client.post('/v1/chat/completions', json=payload, headers=headers)
                    assert response.status == 429
                    report['twenty_successes_then_daily_rejection'] = True
                    quota = await (await client.get('/account', headers=headers)).json()
                    assert quota['quota']['tokensUsed'] == 2400 and quota['quota']['tokensReserved'] == 0
                    report['stream_and_actual_token_settlement'] = True
                    count = calls['count']
                    fixture('suspend', name, id=user_id)
                    response = await client.post('/v1/chat/completions', json=payload, headers=headers)
                    assert response.status == 403 and calls['count'] == count
                    report['forum_ban_rejected_before_forwarding'] = True
                    fixture('unsuspend', name, id=user_id)
                    fixture('rename', name, id=user_id)
                    name += 'r'
                    async with http.get('https://lolicode.com/relay/account', headers=headers) as response:
                        renamed = await response.json()
                        assert response.status == 200
                    assert renamed['account']['username'] == name
                    with ledger.connect() as db:
                        assert db.execute('SELECT gateway_id FROM accounts WHERE forum_id=?', (user_id,)).fetchone()[0] == gateway_id
                    report['rename_keeps_same_mapping'] = True
                    fixture('revoke', name, id=user_id)
                    response = await client.get('/account', headers=headers)
                    assert response.status == 401
                    report['revoked_forum_token_rejected'] = True
                finally:
                    await client.close()
    finally:
        if channel_id is not None:
            matches = [c for c in dashboard.request('/api/channel/')['items'] if c['id'] == channel_id]
            assert len(matches) == 1 and matches[0]['name'] == test_name
            dashboard.request('/api/channel/' + str(channel_id), method='DELETE')
        if gateway_id is None:
            with Ledger(ROOT / 'bridge-state/bridge.sqlite3').connect() as db:
                row = db.execute('SELECT gateway_id FROM accounts WHERE forum_id=?', (user_id,)).fetchone()
                gateway_id = row['gateway_id'] if row else None
        if gateway_id is None:
            matches = [u for u in dashboard.request('/api/user/search?keyword=lc_' + user_id)['items']
                       if u['username'] == 'lc_' + user_id and u['role'] == 1]
            assert len(matches) <= 1
            gateway_id = matches[0]['id'] if matches else None
        if gateway_id is not None:
            assert type(gateway_id) is int and gateway_id > 1 and user_id.isdigit()
            # Exact fixture IDs and immutable lc_<forum_id> names only. Keep audit records.
            sql = ("BEGIN; UPDATE tokens SET status=2,deleted_at=NOW() WHERE user_id=" + str(gateway_id)
                + " AND name='lolicode-bridge-internal'; UPDATE users SET status=2,deleted_at=NOW() WHERE id="
                + str(gateway_id) + " AND username='lc_" + user_id + "' AND role=1; COMMIT;")
            subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'psql', '-U', 'lolicode_relay',
                '-d', 'lolicode_relay', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        with Ledger(ROOT / 'bridge-state/bridge.sqlite3').connect() as db:
            db.execute('DELETE FROM accounts WHERE forum_id=? AND username IN (?,?)', (user_id, name, name.removesuffix('r')))
        fixture('delete', name, id=user_id)
        server.shutdown()
        server.server_close()
    report['temporary_accounts_channels_removed'] = True
    assert dashboard.request('/api/channel/')['total'] == 0
    target = ROOT / 'bridge-verification.json'
    target.write_text(json.dumps(report, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
