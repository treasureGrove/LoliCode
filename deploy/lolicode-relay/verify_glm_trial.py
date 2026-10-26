#!/usr/bin/env python3
"""Two real Flash calls through a temporary ordinary forum account, then quota gates.

Only the owned fixture's ledger is seeded/removed for exhaustion checks. No
existing member allowance is changed, and no mail/notification is sent.
"""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time
import uuid

import aiohttp
from backup import COMPOSE
from bootstrap import Dashboard, ROOT
from bridge import Ledger, calendar
from verify_bridge import fixture


async def main():
    dashboard = Dashboard()
    dashboard.login()
    policy = json.loads((ROOT / 'bridge-policy.json').read_text())
    assert [m['id'] for m in policy['models']] == ['glm-5.3-flash']
    assert policy['daily_requests'] == 20 and policy['daily_tokens'] == 100000
    assert policy['max_concurrent_global'] == 1 and policy['global_requests_per_minute'] == 6
    assert policy['global_daily_requests'] == 200 and policy['global_daily_tokens'] == 1000000
    ledger = Ledger(ROOT / 'bridge-state/bridge.sqlite3')
    name = 'relaytest' + uuid.uuid4().hex[:12]
    password = uuid.uuid4().hex + 'Lc!'
    user_id = fixture('create', name, password=password)['id']
    gateway_id = None
    report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'model': 'glm-5.3-flash',
              'real_inference_calls': 0, 'checks': {}}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=310)) as http:
            async with http.post('https://lolicode.com/api/token', json={
                    'identification': name, 'password': password, 'remember': True}) as response:
                assert response.status == 200
                login = await response.json()
            headers = {'Authorization': 'Bearer lc1.' + user_id + '.' + login['token']}
            base = 'https://lolicode.com/relay'
            async with http.get(base + '/account', headers=headers) as response:
                account = await response.json()
                assert response.status == 200 and account['ready'] is True
            assert account['account']['id'] == user_id
            assert account['quota']['requestsRemaining'] == 20
            assert account['quota']['tokensRemaining'] == 100000
            assert account['limits']['maxConcurrentGlobal'] == 1
            with ledger.connect() as db:
                material = dict(db.execute('SELECT * FROM accounts WHERE forum_id=?', (user_id,)).fetchone())
            gateway_id = material['gateway_id']
            mirror = dashboard.request('/api/user/' + str(gateway_id))
            assert mirror['role'] == 1 and mirror['username'] == 'lc_' + user_id
            report['checks']['ordinary_forum_login_and_independent_allowance'] = True
            async with http.get(base + '/v1/models', headers=headers) as response:
                listing = await response.json()
                assert response.status == 200
            assert [m['id'] for m in listing['data']] == ['glm-5.3-flash']
            report['checks']['only_flash_visible'] = True
            payload = {'model': 'glm-5.3-flash', 'messages': [
                {'role': 'user', 'content': 'Reply with exactly OK.'}], 'max_tokens': 256}
            async with http.post(base + '/v1/chat/completions', json=payload) as response:
                assert response.status == 401
                await response.read()
            async with http.post(base + '/v1/chat/completions', json={**payload, 'model': 'gpt-6-luna'},
                                 headers=headers) as response:
                assert response.status == 403
                await response.read()
            report['checks']['anonymous_and_other_models_rejected'] = True
            usage = []
            async with http.post(base + '/v1/chat/completions', json=payload, headers=headers) as response:
                assert response.status == 200, 'Normal Flash inference failed'
                result = await response.json()
            report['real_inference_calls'] += 1
            assert result['choices'][0]['message'].get('content'), 'No final text returned'
            assert material['gateway_key'] not in json.dumps(result)
            usage.append(result['usage']['prompt_tokens'] + result['usage']['completion_tokens'])
            report['checks']['normal_response_has_text_and_usage'] = True
            stream_usage, text, done = None, '', False
            async with http.post(base + '/v1/chat/completions', json={**payload, 'stream': True},
                                 headers=headers) as response:
                assert response.status == 200, 'Streaming Flash inference failed'
                pending = b''
                async for chunk in response.content.iter_chunked(16384):
                    pending += chunk
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        if not line.startswith(b'data: '):
                            continue
                        if line.strip() == b'data: [DONE]':
                            done = True
                            continue
                        value = json.loads(line[6:])
                        for choice in value.get('choices', []):
                            text += choice.get('delta', {}).get('content') or ''
                        if isinstance(value.get('usage'), dict):
                            stream_usage = value['usage']['prompt_tokens'] + value['usage']['completion_tokens']
            report['real_inference_calls'] += 1
            assert done and text and stream_usage is not None
            assert material['gateway_key'] not in text
            usage.append(stream_usage)
            # The server settles the ledger immediately after the final SSE bytes.
            for _ in range(10):
                async with http.get(base + '/account', headers=headers) as response:
                    current = await response.json()
                if current['quota']['tokensReserved'] == 0:
                    break
                await asyncio.sleep(0.1)
            assert current['quota']['requestsUsed'] == 2
            assert current['quota']['tokensUsed'] == sum(usage)
            assert current['quota']['tokensReserved'] == 0
            report['checks']['stream_and_exact_raw_token_settlement'] = True
            report['real_raw_tokens'] = sum(usage)
            day = calendar()[0]
            with ledger.connect() as db:
                for index in range(18):
                    db.execute('''INSERT INTO requests(id,forum_id,day,reserved,charged,state,model,created_at)
                        VALUES(?,?,?,?,?,?,?,?)''', ('trial-fixture-' + uuid.uuid4().hex, user_id,
                        day, 0, 0, 'charged', 'glm-5.3-flash', time.time() - 120))
            async with http.post(base + '/v1/chat/completions', json=payload, headers=headers) as response:
                assert response.status == 429
                assert (await response.json())['error']['code'] == 'daily_requests_exhausted'
            report['checks']['twenty_request_ceiling_rejected_without_upstream_call'] = True
            with ledger.connect() as db:
                db.execute('DELETE FROM requests WHERE forum_id=?', (user_id,))
                db.execute('''INSERT INTO requests(id,forum_id,day,reserved,charged,state,model,created_at)
                    VALUES(?,?,?,?,?,?,?,?)''', ('trial-fixture-' + uuid.uuid4().hex, user_id,
                    day, 100000, 100000, 'charged', 'glm-5.3-flash', time.time() - 120))
            async with http.post(base + '/v1/chat/completions', json=payload, headers=headers) as response:
                assert response.status == 429
                assert (await response.json())['error']['code'] == 'daily_tokens_exhausted'
            report['checks']['hundred_thousand_token_ceiling_rejected_without_upstream_call'] = True
            async with http.get('https://relay.lolicode.com/v1/models') as response:
                assert response.status == 404
                await response.read()
            report['checks']['raw_gateway_not_public'] = True
    finally:
        with ledger.connect() as db:
            row = db.execute('SELECT gateway_id FROM accounts WHERE forum_id=? AND username=?',
                             (user_id, name)).fetchone()
            gateway_id = row['gateway_id'] if row else gateway_id
        if gateway_id is not None:
            mirror = dashboard.request('/api/user/' + str(gateway_id))
            assert mirror['role'] == 1 and mirror['username'] == 'lc_' + user_id
            assert type(gateway_id) is int and gateway_id > 1 and user_id.isdigit()
            # Keep audit records; remove only this exact owned fixture identity.
            sql = ("BEGIN; UPDATE tokens SET status=2,deleted_at=NOW() WHERE user_id=" + str(gateway_id)
                + " AND name='lolicode-bridge-internal'; UPDATE users SET status=2,deleted_at=NOW() WHERE id="
                + str(gateway_id) + " AND username='lc_" + user_id + "' AND role=1; COMMIT;")
            subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'psql', '-U', 'lolicode_relay',
                '-d', 'lolicode_relay', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        with ledger.connect() as db:
            db.execute('DELETE FROM requests WHERE forum_id=?', (user_id,))
            db.execute('DELETE FROM accounts WHERE forum_id=? AND username=?', (user_id, name))
        fixture('delete', name, id=user_id)
    report['checks']['temporary_accounts_and_test_allowances_removed'] = True
    target = ROOT / 'glm-trial-verification.json'
    target.write_text(json.dumps(report, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps(report))


if __name__ == '__main__':
    asyncio.run(main())
