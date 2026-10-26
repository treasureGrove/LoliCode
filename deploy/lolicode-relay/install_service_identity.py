#!/usr/bin/env python3
"""Give the bridge its own restricted identity so the owner's password can change."""
import argparse
from pathlib import Path
from migrate import remote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode')
    args = parser.parse_args()
    source = Path(__file__).with_name('bridge.py').read_text(encoding='utf8')
    print(remote(args.host, r'''
owned()
import secrets, urllib.request, urllib.error
run(['python3', str(ROOT / 'backup.py')])
sys.path.insert(0, str(ROOT))
from bootstrap import Dashboard
root = Dashboard()
root.login()
owner = json.loads((ROOT / 'admin-credentials.json').read_text())
def call(method, path, data=None, token=None, proof=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    if proof: headers['X-Security-Proof'] = proof
    request = urllib.request.Request('http://127.0.0.1:13000' + path,
        data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError('Service identity HTTP error: ' + str(error.code) + ' ' + path) from None
    if result.get('success') is not True:
        raise RuntimeError('Service identity operation rejected: ' + path)
    return result.get('data')
name = 'lc_bridge_service'
file = ROOT / 'bridge-service-credentials.json'
marker = ROOT / '.lolicode-bridge-service-owned'
if file.is_symlink() or marker.is_symlink():
    raise RuntimeError('Unexpected service identity path')
if file.exists():
    credential = json.loads(file.read_text())
    if credential.get('username') != name:
        raise RuntimeError('Unrecognized bridge identity')
else:
    existing = root.request('/api/user/search?keyword=' + name)
    if any(user['username'] == name for user in existing['items']):
        raise RuntimeError('An unowned bridge identity already exists')
    credential = {'username': name, 'password': 'Lc!' + secrets.token_urlsafe(30)}
    with file.open('x') as output:
        json.dump(credential, output)
    file.chmod(0o600)
found = root.request('/api/user/search?keyword=' + name)
users = [user for user in found['items'] if user['username'] == name]
catalog = root.request('/api/user/access_tokens/catalog')
permissions = {item['resource']: {action['action']: False for action in item['actions']}
               for group in catalog['groups'] if group['group'] in ('admin', 'system')
               for item in group['resources']}
permissions['user'] = {'read': True, 'write': True}
if not users:
    proof = root.request('/api/verify', {'method': 'password', 'scope': 'admin.user.create',
        'context': {'role': 10}, 'password': owner['password']})['proof_token']
    call('POST', '/api/user/', {**credential, 'display_name': 'LoliCode Bridge', 'role': 10,
        'admin_permissions': permissions}, root.token, proof)
    users = [user for user in root.request('/api/user/search?keyword=' + name)['items'] if user['username'] == name]
if len(users) != 1 or users[0]['role'] != 10:
    raise RuntimeError('Unexpected bridge service role')
login = call('POST', '/api/user/login', credential)
service_user = call('GET', '/api/user/self', token=login['access_token'])
actual = service_user['permissions']['admin_permissions']
if any(bool(enabled) != bool(permissions.get(resource, {}).get(action, False))
       for resource, actions in actual.items() for action, enabled in actions.items()):
    raise RuntimeError('Bridge service has unexpected permissions')
if service_user['id'] != users[0]['id'] or service_user['username'] != name:
    raise RuntimeError('Bridge service identity mismatch')
scopes = ['user:read', 'user:write']
if not credential.get('access_token'):
    proof = call('POST', '/api/verify', {'method': 'password', 'scope': 'access_token.generate',
        'context': {'scopes': scopes, 'expires_at': 0}, 'password': credential['password']},
        login['access_token'])['proof_token']
    created = call('POST', '/api/user/access_tokens', {'name': 'lolicode-identity-bridge',
        'scopes': scopes, 'expires_at': 0}, login['access_token'], proof)
    if sorted(created['item']['scopes']) != scopes:
        raise RuntimeError('Unexpected machine token scopes')
    credential['access_token'] = created['token']
    credential['token_id'] = created['item']['id']
    file.write_text(json.dumps(credential) + '\n')
    file.chmod(0o600)
# Inspect a harmless permitted endpoint, then verify the machine credential
# cannot access system settings, even though the installer still has root.
call('GET', '/api/user/search?keyword=lc_', token=credential['access_token'])
request = urllib.request.Request('http://127.0.0.1:13000/api/option/',
    headers={'Authorization': 'Bearer ' + credential['access_token']})
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        raise RuntimeError('Machine token must not access system settings')
except urllib.error.HTTPError as error:
    if error.code != 403: raise
marker.write_text(json.dumps({'username': name, 'id': service_user['id'], 'role': 10,
                             'token_id': credential['token_id'], 'scopes': scopes}) + '\n')
marker.chmod(0o600)
bridge = ROOT / 'bridge.py'
old = bridge.read_text()
before = payload['source'].replace("ROOT / 'bridge-service-credentials.json'", "ROOT / 'admin-credentials.json'")
before = before.replace("""        if self.credentials.get('access_token'):
            # A scoped machine token must fail closed, never fall back to a
            # password login with the service account's broader role.
            return await self.call(method, path, data, self.credentials['access_token'])
""", '')
if bridge.is_symlink() or old not in (before, payload['source']):
    raise RuntimeError('Bridge source changed; preserve and review it before cutover')
if old != payload['source']:
    shutil.copy2(bridge, ROOT / 'bridge.py.pre-service-identity')
    bridge.write_text(payload['source'])
    bridge.chmod(0o600)
run(['python3', '-m', 'unittest', '-q', 'test_bridge'], cwd=ROOT)
run(['systemctl', 'restart', 'lolicode-relay-bridge.service'])
import time
for attempt in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:13001/health', timeout=2) as response:
            if json.load(response).get('ok'): break
    except OSError:
        if attempt == 19: raise
        time.sleep(0.25)
emit({'bridge_identity': name, 'role': 10, 'token_scopes': scopes, 'system_settings_denied': True,
      'owner_password_dependency_removed': True, 'bridge_healthy': True})
''', {'source': source}))


if __name__ == '__main__':
    main()
