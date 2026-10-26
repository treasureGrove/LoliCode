"""Public HTTPS browser-login acceptance with a disposable forum account; no model calls."""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import subprocess
import time
import uuid

import aiohttp
from backup import COMPOSE, ROOT
from bootstrap import Dashboard
from bridge import Ledger, calendar
from verify_bridge import fixture
from web_account import COOKIE, ORIGIN


async def main():
    name = 'relaytest' + uuid.uuid4().hex[:12]
    password = secrets.token_urlsafe(32)
    user_id = fixture('create', name, password=password)['id']
    ledger = Ledger(ROOT / 'bridge-state/bridge.sqlite3')
    dashboard = Dashboard()
    dashboard.login()
    report = {'timestamp': datetime.now(timezone.utc).isoformat(), 'real_model_calls': 0, 'checks': {}}
    headers = {'Origin': ORIGIN, 'Sec-Fetch-Site': 'same-origin'}
    credentials = {'identification': name, 'password': password}
    try:
        async with aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar()) as http:
            async def request(method, path, body=None, cookie=None, extra=None):
                request_headers = {**headers, **(extra or {})}
                if cookie:
                    request_headers['Cookie'] = cookie
                async with http.request(method, ORIGIN + path, json=body, headers=request_headers,
                                        allow_redirects=False, timeout=aiohttp.ClientTimeout(total=30)) as response:
                    raw = await response.read()
                    return response.status, dict(response.headers), raw, response.cookies

            status, _, _, _ = await request('GET', '/account-api/account')
            assert status == 401, 'Anonymous web account must be rejected'
            status, _, _, _ = await request('POST', '/account-api/login', credentials, extra={'Origin': 'https://evil.invalid'})
            assert status == 403, 'Foreign-origin login accepted'
            status, _, _, _ = await request('POST', '/account-api/login', {**credentials, 'password': 'wrong-test-password'})
            assert status == 401, 'Wrong password accepted'
            # A new ordinary account must log in without prior New API registration.
            status, response_headers, raw, cookies = await request('POST', '/account-api/login', credentials)
            assert status == 200, ('Existing forum login failed', status)
            value = json.loads(raw)
            assert value['account']['id'] == user_id
            assert value['quota']['requestLimit'] == 20 and value['quota']['tokenLimit'] == 100000
            assert value['quota']['requestsUsed'] == 0
            assert 'email' not in value['account'] and password.encode() not in raw
            cookie_value = cookies[COOKIE]
            assert cookie_value['secure'] and cookie_value['httponly'] and cookie_value['samesite'] == 'Lax'
            assert cookie_value['path'] == '/' and 'domain=' not in response_headers['Set-Cookie'].lower()
            assert response_headers.get('Cache-Control') == 'no-store'
            assert 'Access-Control-Allow-Origin' not in response_headers
            cookie = COOKIE + '=' + cookie_value.value
            report['checks']['new_forum_account_login_and_secure_private_session'] = True
            with ledger.connect() as db:
                mapping = dict(db.execute('SELECT * FROM accounts WHERE forum_id=?', (user_id,)).fetchone())
            mirror = dashboard.request('/api/user/' + str(mapping['gateway_id']))
            assert mirror['role'] == 1 and mirror['username'] == 'lc_' + user_id
            assert mapping['gateway_key'].encode() not in raw
            report['checks']['normal_role_only_and_no_key_exposure'] = True
            # An owned fixture record proves both surfaces read the same daily ledger.
            with ledger.connect() as db:
                db.execute('''INSERT INTO requests(id,forum_id,day,reserved,charged,state,model,created_at)
                    VALUES(?,?,?,?,?,?,?,?)''', ('web-fixture-' + uuid.uuid4().hex, user_id, calendar()[0],
                    321, 321, 'charged', 'web-verification-only', time.time() - 120))
            status, _, raw, _ = await request('GET', '/account-api/account', cookie=cookie)
            assert status == 200
            web_quota = json.loads(raw)['quota']
            assert web_quota['requestsRemaining'] == 19 and web_quota['tokensRemaining'] == 99679
            async with http.post('https://lolicode.com/api/token', json={**credentials, 'remember': False}) as response:
                assert response.status == 200
                login = await response.json()
            bearer = 'Bearer lc1.' + user_id + '.' + login['token']
            async with http.get('https://lolicode.com/relay/account', headers={'Authorization': bearer}) as response:
                assert response.status == 200
                client_status = await response.json()
            assert client_status['quota'] == web_quota
            report['checks']['web_and_client_share_exact_daily_allowance'] = True
            status, _, _, _ = await request('GET', '/api/user/self', cookie=cookie)
            assert status in (401, 403), 'Browser session authorized native admin API'
            status, _, _, _ = await request('GET', '/v1/models', cookie=cookie)
            assert status == 404
            async with http.get('https://lolicode.com/relay/account', headers={'Cookie': cookie}) as response:
                assert response.status == 401
                await response.read()
            async with http.post('https://lolicode.com/relay/web/login', json=credentials, headers=headers) as response:
                assert response.status == 404
                await response.read()
            report['checks']['browser_cannot_authorize_admin_or_inference_and_no_alternate_web_login'] = True
            fixture('suspend', name, id=user_id)
            status, _, _, _ = await request('GET', '/account-api/account', cookie=cookie)
            assert status == 403
            fixture('unsuspend', name, id=user_id)
            # Keep public login-rate protection intact during acceptance checks.
            await asyncio.sleep(7)
            status, _, _, cookies = await request('POST', '/account-api/login', credentials)
            assert status == 200, ('Re-login after unsuspension failed', status)
            cookie = COOKIE + '=' + cookies[COOKIE].value
            status, _, _, _ = await request('POST', '/account-api/logout', {}, cookie=cookie)
            assert status == 200
            status, _, _, _ = await request('GET', '/account-api/account', cookie=cookie)
            assert status == 401
            report['checks']['suspension_and_logout_invalidate_browser_session'] = True
            for path in ('/sign-in', '/login'):
                status, response_headers, _, _ = await request('GET', path)
                assert status == 302 and response_headers['Location'].endswith('/account')
            status, _, raw, _ = await request('GET', '/sign-in?admin=1')
            assert status == 200 and b'/relay-assets/admin-theme.css' in raw
            report['checks']['public_login_routes_and_separate_admin_entry'] = True
    finally:
        with ledger.connect() as db:
            row = db.execute('SELECT gateway_id FROM accounts WHERE forum_id=? AND username=?', (user_id, name)).fetchone()
        if row and row['gateway_id']:
            gateway_id = row['gateway_id']
            mirror = dashboard.request('/api/user/' + str(gateway_id))
            assert mirror['role'] == 1 and mirror['username'] == 'lc_' + user_id
            assert type(gateway_id) is int and gateway_id > 1 and user_id.isdigit()
            sql = ("BEGIN; UPDATE tokens SET status=2,deleted_at=NOW() WHERE user_id=" + str(gateway_id)
                + " AND name='lolicode-bridge-internal'; UPDATE users SET status=2,deleted_at=NOW() WHERE id="
                + str(gateway_id) + " AND username='lc_" + user_id + "' AND role=1; COMMIT;")
            subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'psql', '-U', 'lolicode_relay',
                '-d', 'lolicode_relay', '-v', 'ON_ERROR_STOP=1', '-c', sql],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        with ledger.connect() as db:
            db.execute('DELETE FROM web_sessions WHERE forum_id=?', (user_id,))
            db.execute('DELETE FROM requests WHERE forum_id=?', (user_id,))
            db.execute('DELETE FROM accounts WHERE forum_id=? AND username=?', (user_id, name))
        fixture('delete', name, id=user_id)
    report['checks']['owned_temporary_accounts_and_allowance_records_cleaned'] = True
    target = ROOT / 'web-account-verification.json'
    target.write_text(json.dumps(report, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps(report))


if __name__ == '__main__':
    asyncio.run(main())
