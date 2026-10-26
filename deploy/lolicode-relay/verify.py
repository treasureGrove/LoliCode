#!/usr/bin/env python3
"""Exercise the installed gateway with a local mock, never a paid upstream."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.request
import uuid

from bootstrap import BASE, Dashboard, ROOT
from backup import COMPOSE


def command(*args, **kwargs):
    return subprocess.run(list(args), check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=120, **kwargs).stdout


def relay(payload, key=None):
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    request = urllib.request.Request(BASE + '/v1/chat/completions',
                                     data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def main():
    client = Dashboard()
    client.login()
    assert client.request('/api/setup')['status'] is True
    assert client.request('/api/channel/')['total'] == 0, 'Only run against an empty foundation'
    options = {entry['key']: entry['value'] for entry in client.request('/api/option/')}
    assert options['RegisterEnabled'] == 'false'
    assert options['PasswordRegisterEnabled'] == 'false'
    test_id = 'foundation-smoke-' + uuid.uuid4().hex[:12]
    mock_key = uuid.uuid4().hex
    gateway = command('docker', 'network', 'inspect', 'lolicode-relay_relay',
                      '--format', '{{(index .IPAM.Config 0).Gateway}}').decode().strip()
    state = {'calls': 0}
    state_lock = threading.Lock()

    class Mock(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            assert self.path == '/v1/chat/completions'
            assert self.headers.get('Authorization') == 'Bearer ' + mock_key
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with state_lock:
                state['calls'] += 1
            time.sleep(0.15)
            common = {'id': 'chatcmpl-foundation', 'created': int(time.time()), 'model': 'gpt-4o-mini'}
            usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}
            if payload.get('stream'):
                chunks = [
                    {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [
                        {'index': 0, 'id': 'call_foundation', 'type': 'function',
                         'function': {'name': 'foundation_probe', 'arguments': '{'}}]}, 'finish_reason': None}]},
                    {'choices': [{'index': 0, 'delta': {'tool_calls': [
                        {'index': 0, 'function': {'arguments': '"ok":true}'}}]}, 'finish_reason': 'tool_calls'}]},
                    {'choices': [], 'usage': usage},
                ]
                body = ''.join('data: ' + json.dumps({**common, 'object': 'chat.completion.chunk', **chunk})
                               + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
                content_type = 'text/event-stream'
            else:
                message = {'role': 'assistant', 'content': 'relay-smoke-ok'}
                if payload.get('tools'):
                    message['tool_calls'] = [{'id': 'call_foundation', 'type': 'function',
                        'function': {'name': 'foundation_probe', 'arguments': '{"ok":true}'}}]
                body = json.dumps({**common, 'object': 'chat.completion',
                    'choices': [{'index': 0, 'message': message,
                                 'finish_reason': 'tool_calls' if payload.get('tools') else 'stop'}],
                    'usage': usage})
                content_type = 'application/json'
            encoded = body.encode()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer((gateway, 0), Mock)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    channel_id = None
    token_ids = []
    report = {'timestamp': datetime.now(timezone.utc).isoformat(),
              'upstream': 'temporary local mock', 'paid_requests': 0}
    payload = {'model': 'gpt-4o-mini', 'messages': [{'role': 'user', 'content': 'foundation probe'}],
               'max_tokens': 32}
    tools = [{'type': 'function', 'function': {'name': 'foundation_probe',
              'parameters': {'type': 'object', 'properties': {}}}}]

    def create_token(suffix, quota):
        name = test_id + suffix
        client.request('/api/token/', {'name': name, 'expired_time': -1, 'remain_quota': quota,
            'unlimited_quota': False, 'model_limits_enabled': True, 'model_limits': 'gpt-4o-mini'})
        matches = [item for item in client.request('/api/token/?page_size=100')['items'] if item['name'] == name]
        assert len(matches) == 1
        token_id = matches[0]['id']
        token_ids.append(token_id)
        key = client.request('/api/token/' + str(token_id) + '/key', {}, 'POST')['key']
        return token_id, key

    try:
        assert relay(payload)[0] == 401
        report['unauthenticated_rejected'] = True
        client.request('/api/channel/', {'mode': 'single', 'channel': {
            'type': 1, 'name': test_id, 'key': mock_key, 'status': 1,
            'models': 'gpt-4o-mini', 'group': 'default',
            'base_url': 'http://' + gateway + ':' + str(server.server_port),
        }})
        channels = [item for item in client.request('/api/channel/')['items'] if item['name'] == test_id]
        assert len(channels) == 1
        channel_id = channels[0]['id']
        token_id, key = create_token('-ok', 100000)
        # Channel writes become visible after New API's periodic cache sync.
        for attempt in range(20):
            status, body = relay(payload, key)
            if status != 503:
                break
            time.sleep(2)
        assert status == 200, ('plain relay failed', status, body[:300])
        assert json.loads(body)['choices'][0]['message']['content'] == 'relay-smoke-ok'
        report['chat_forwarding'] = True
        status, body = relay({**payload, 'tools': tools}, key)
        assert status == 200
        call = json.loads(body)['choices'][0]['message']['tool_calls'][0]
        assert call['function']['name'] == 'foundation_probe'
        assert json.loads(call['function']['arguments']) == {'ok': True}
        report['tool_call_forwarding'] = True
        status, body = relay({**payload, 'tools': tools, 'stream': True,
                              'stream_options': {'include_usage': True}}, key)
        assert status == 200 and b'[DONE]' in body
        fragments = []
        for line in body.decode().splitlines():
            if line.startswith('data: ') and line != 'data: [DONE]':
                chunk = json.loads(line[6:])
                for choice in chunk.get('choices', []):
                    for call in choice.get('delta', {}).get('tool_calls', []):
                        fragments.append(call.get('function', {}).get('arguments', ''))
        assert json.loads(''.join(fragments)) == {'ok': True}
        report['streaming_tool_call_forwarding'] = True
        before = state['calls']
        assert relay({**payload, 'model': 'gpt-4o'}, key)[0] == 403
        assert state['calls'] == before
        report['model_whitelist_enforced'] = True
        _, empty_key = create_token('-zero', 0)
        # This New API version intentionally reports an exhausted key as an
        # authentication failure; both 401 and 403 reject before forwarding.
        assert relay(payload, empty_key)[0] in (401, 403)
        assert state['calls'] == before
        report['zero_quota_rejected_before_upstream'] = True
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = [pool.submit(relay, payload, key) for _ in range(10)]
            results = [future.result() for future in futures]
        assert all(code == 200 for code, _ in results)
        report['mock_concurrency'] = {'requests': 10, 'success': 10,
                                      'elapsed_seconds': round(time.monotonic() - started, 3)}
        token = client.request('/api/token/' + str(token_id))
        assert token['remain_quota'] < 100000 and token['used_quota'] > 0
        report['usage_accounting'] = True
        report['mock_upstream_calls'] = state['calls']
    finally:
        for token_id in token_ids:
            current = client.request('/api/token/' + str(token_id))
            assert current['name'].startswith(test_id)
            client.request('/api/token/' + str(token_id), method='DELETE')
        if channel_id is not None:
            matches = [item for item in client.request('/api/channel/')['items'] if item['id'] == channel_id]
            assert len(matches) == 1 and matches[0]['name'] == test_id
            client.request('/api/channel/' + str(channel_id), method='DELETE')
        server.shutdown()
        server.server_close()
    assert client.request('/api/channel/')['total'] == 0
    report['temporary_resources_removed'] = True

    command(*COMPOSE, 'restart', 'new-api')
    for attempt in range(60):
        try:
            assert client.request('/api/setup')['status'] is True
            options = {item['key']: item['value'] for item in client.request('/api/option/')}
            assert options['RegisterEnabled'] == 'false'
            break
        except (OSError, RuntimeError):
            if attempt == 59:
                raise
            time.sleep(1)
    report['restart_persistence'] = True
    command('systemctl', 'start', 'lolicode-relay-backup.service')
    archive = sorted((ROOT / 'backups').glob('relay-*.tar.gz'))[-1]
    database = 'relay_verify_' + uuid.uuid4().hex[:16]
    assert re.fullmatch(r'relay_verify_[0-9a-f]{16}', database)
    pg = COMPOSE + ['exec', '-T', 'postgres']
    command(*pg, 'createdb', '-U', 'lolicode_relay', database)
    try:
        with tarfile.open(archive, 'r:gz') as backup:
            dump = backup.extractfile('database.dump').read()
        command(*pg, 'pg_restore', '-U', 'lolicode_relay', '-d', database,
                '--exit-on-error', '--no-owner', input=dump)
        counts = command(*pg, 'psql', '-U', 'lolicode_relay', '-d', database, '-Atc',
                         'SELECT count(*) FROM users WHERE role=100;').decode().strip()
        assert counts == '1'
        report['backup_restore_verified'] = True
    finally:
        command(*pg, 'dropdb', '-U', 'lolicode_relay', database)
    report['backup_archive'] = archive.name
    report['container_stats'] = command(*COMPOSE, 'stats', '--no-stream', '--format',
                                        '{{.Name}} {{.MemUsage}} {{.CPUPerc}}').decode().splitlines()
    report['limits_mib'] = {'new-api': 512, 'postgres': 320, 'redis': 96}
    target = ROOT / 'verification.json'
    target.write_text(json.dumps(report, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
