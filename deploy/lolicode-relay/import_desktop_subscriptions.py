#!/usr/bin/env python3
"""Create disabled private preview channels from existing desktop subscriptions.

Only a current Codex access token is copied: no refresh token, token exchange,
or local login-file change. GLM uses one short-lived project token, without
copying the website login token to server storage. Public access stays closed.
"""
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

from migrate import remote


IMPORT = r'''
owned()
sys.path.insert(0, str(ROOT))
from bootstrap import Dashboard
import urllib.request, urllib.parse, urllib.error, time
client = Dashboard()
client.login()
policy_before = (ROOT / 'bridge-policy.json').read_bytes()
if json.loads(policy_before)['models']:
    raise RuntimeError('Private subscription preview requires the public catalog to remain closed')
receipt_path = ROOT / 'desktop-subscription-preview.json'
if receipt_path.exists():
    raise RuntimeError('Subscription preview already exists; inspect before importing again')
existing_names = {c['name'] for c in client.request('/api/channel/')['items']}
sources = payload['sources']
if any(s['name'] in existing_names for s in sources):
    raise RuntimeError('A selected preview channel already exists; refusing to overwrite it')
backup = json.loads(run(['python3', str(ROOT / 'backup.py')]))
options = {x['key']: x['value'] for x in client.request('/api/option/')}
ratios = json.loads(options['ModelRatio'])
added = []
for source in sources:
    for model_id in source['models']:
        if model_id not in ratios:
            ratios[model_id] = 1
            added.append(model_id)
if added:
    client.request('/api/option/', {'key': 'ModelRatio', 'value': json.dumps(ratios)}, 'PUT')
receipt = {'created_at': datetime.now(timezone.utc).isoformat(), 'backup': backup['backup'],
    'public_catalog_open': False, 'refresh_tokens_copied': False,
    'added_ratio_models': added, 'channels': [], 'failures': []}
for source in sources:
    key = source.get('key')
    expires_at = source.get('expires_at')
    if source['kind'] == 'glm':
        account = source['account']
        loc = account['location']
        segments = ['api', 'biz', 'v1', 'organization', loc['organization_id'],
                    'projects', loc['project_id'], 'api_keys', loc['key_id'], 'access_tokens']
        url = 'https://bigmodel.cn/' + '/'.join(urllib.parse.quote(s, safe='') for s in segments)
        req = urllib.request.Request(url, method='POST',
            data=json.dumps({'clientType': 'zcode', 'clientVersion': payload['client_version']}).encode(),
            headers={'Authorization': 'Bearer ' + account['access_token'],
                     'Content-Type': 'application/json'})
        started = int(time.time())
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.load(response)
            data = result.get('data', {})
            if (result.get('code') not in (0, 200) or data.get('enable') is False
                    or data.get('tokenType') != 'Bearer' or not data.get('accessToken')
                    or not isinstance(data.get('expiresIn'), int)
                    or not isinstance(data.get('expiresAt'), int)):
                raise ValueError('Invalid project token result')
            expiry = min(started + data['expiresIn'], data['expiresAt'])
            if expiry <= int(time.time()):
                raise ValueError('Project token already expired')
            key = data['accessToken']
            expires_at = datetime.fromtimestamp(expiry, timezone.utc).isoformat()
        except Exception as error:
            failure = {'source': source['name'], 'error_class': type(error).__name__}
            if isinstance(error, urllib.error.HTTPError):
                failure['http_status'] = error.code
            receipt['failures'].append(failure)
            continue
    client.request('/api/channel/', {'mode': 'single', 'channel': {
        'name': source['name'], 'type': source['type'], 'key': key, 'status': 2,
        'models': ','.join(source['models']), 'group': 'default',
        'base_url': source['base_url'], 'test_model': source['test_model'],
        'remark': 'Private subscription preview; disabled. Access token expires ' + str(expires_at)}})
    matches = [c for c in client.request('/api/channel/')['items'] if c['name'] == source['name']]
    assert len(matches) == 1 and matches[0]['status'] == 2
    receipt['channels'].append({'id': matches[0]['id'], 'name': source['name'],
        'kind': source['kind'], 'models': source['models'], 'type': source['type'],
        'test_model': source['test_model'], 'expires_at': expires_at, 'status': 2})
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    receipt_path.chmod(0o600)
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
assert (ROOT / 'bridge-policy.json').read_bytes() == policy_before
emit(receipt)
'''


def main():
    desktop = Path.home() / '.tai-switch'
    with sqlite3.connect((desktop / 'cc-switch.db').as_uri() + '?mode=ro', uri=True) as db:
        catalog = json.loads(db.execute("SELECT value FROM settings WHERE key='channel_center'").fetchone()[0])
    sources = []
    codex = next(c for c in catalog['channels'] if c['enabled'] and c['authKind'] == 'codex_oauth')
    login = json.loads((Path.home() / '.codex' / 'auth.json').read_text(encoding='utf-8-sig'))['tokens']
    manager = json.loads((desktop / 'codex_oauth_auth.json').read_text(encoding='utf-8-sig'))
    expected = manager['accounts'][codex['accountId']]['chatgpt_account_id']
    if login['account_id'] != expected:
        raise RuntimeError('Active Codex login differs from the selected LoliCode account')
    access = login['access_token']
    claims = json.loads(base64.urlsafe_b64decode(access.split('.')[1] + '==='))
    expiry = datetime.fromtimestamp(claims['exp'], timezone.utc)
    if expiry <= datetime.now(timezone.utc):
        raise RuntimeError('Current access token is expired; local login preserved')
    models = [m['id'] for m in codex['models'] if m.get('enabled') is not False
              and m['id'].startswith('gpt-') and m['id'] != 'gpt-reserve']
    sources.append({'name': 'Desktop Preview - ChatGPT Pro', 'kind': 'codex', 'type': 57,
        'base_url': 'https://chatgpt.com', 'models': models, 'test_model': 'gpt-6-luna',
        'expires_at': expiry.isoformat(),
        'key': json.dumps({'access_token': access, 'account_id': login['account_id'],
                           'type': 'codex', 'expired': expiry.isoformat()})})
    glm = next(c for c in catalog['channels'] if c['enabled'] and c['authKind'] == 'zhipu_oauth')
    accounts = json.loads((desktop / 'zhipu_oauth_auth.json').read_text(encoding='utf-8-sig'))['accounts']
    account = accounts[glm['accountId']]
    if account['family'] != 'bigmodel' or not account.get('location'):
        raise RuntimeError('Expected an existing Bigmodel project location; no new project will be created')
    sources.append({'name': 'Desktop Preview - GLM Coding Plan', 'kind': 'glm', 'type': 8,
        'base_url': glm['baseUrl'].rstrip('/') + '/chat/completions',
        'models': [m['id'] for m in glm['models'] if m.get('enabled') is not False],
        'test_model': 'glm-5.3-flash',
        'account': {'access_token': account['access_token'], 'location': account['location']}})
    version = json.loads((Path(__file__).resolve().parents[2] / 'package.json').read_text())['version']
    result = remote('lolicode', IMPORT, {'sources': sources, 'client_version': version})
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
