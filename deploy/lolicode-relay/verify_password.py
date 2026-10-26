#!/usr/bin/env python3
"""Exercise password rotation using one disposable account, never the owner."""
from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import urllib.error
import urllib.request
import uuid

ROOT = Path('/opt/lolicode-relay')
BASE = 'http://127.0.0.1:13000'


def main():
    if ROOT.is_symlink():
        raise RuntimeError('Unexpected relay path')
    credential = json.loads((ROOT / 'bridge-service-credentials.json').read_text())
    machine_token = credential['access_token']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(method, path, data=None, token=None, proof=None, allow_failure=False):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if proof:
            headers['X-Security-Proof'] = proof
        req = urllib.request.Request(BASE + path, data=None if data is None else json.dumps(data).encode(),
                                     headers=headers, method=method)
        try:
            response = opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = json.load(response)
            if allow_failure:
                return response.status, result.get('success') is True
            if response.status != 200 or result.get('success') is not True:
                raise RuntimeError('Password acceptance failed: ' + path + ' HTTP ' + str(response.status))
            return result.get('data')

    name = 'lcpw' + uuid.uuid4().hex[:12]
    first, second = 'Lc!' + secrets.token_urlsafe(24), 'Lc!' + secrets.token_urlsafe(24)
    user_id = None
    try:
        call('POST', '/api/user/', {'username': name, 'password': first, 'display_name': 'Password test', 'role': 1}, machine_token)
        found = call('GET', '/api/user/search?keyword=' + name, token=machine_token)
        matches = [user for user in found['items'] if user['username'] == name and user['role'] == 1]
        assert len(matches) == 1
        user_id = matches[0]['id']
        login = call('POST', '/api/user/login', {'username': name, 'password': first})
        old_token = login['access_token']
        proof = call('POST', '/api/verify', {'method': 'password', 'scope': 'account.password.change',
                                           'password': first}, old_token)['proof_token']
        call('PUT', '/api/user/self', {'password': second, 'original_password': first}, old_token, proof)
        old_code, old_success = call('POST', '/api/user/login', {'username': name, 'password': first}, allow_failure=True)
        assert not old_success
        login = call('POST', '/api/user/login', {'username': name, 'password': second})
        assert login['user']['id'] == user_id
        code, success = call('GET', '/api/user/self', token=old_token, allow_failure=True)
        assert code == 401 and not success
        # The bridge uses its own account and token, unaffected by this rotation.
        call('GET', '/api/user/search?keyword=lc_', token=machine_token)
        result = {'checked_at': datetime.now(timezone.utc).isoformat(),
                  'new_password_login': True, 'old_password_rejected': True,
                  'old_session_revoked': True, 'machine_identity_still_works': True,
                  'owner_password_changed': False, 'paid_upstream_requests': 0}
    finally:
        if user_id is not None:
            # Re-read both username and role before deleting only this fixture.
            user = call('GET', '/api/user/' + str(user_id), token=machine_token)
            if user['username'] != name or user['role'] != 1:
                raise RuntimeError('Refusing to clean up an unrelated user')
            proof = call('POST', '/api/verify', {'method': 'password', 'scope': 'admin.user.delete',
                'context': {'user_id': user_id}, 'password': credential['password']}, machine_token)['proof_token']
            call('DELETE', '/api/user/' + str(user_id), token=machine_token, proof=proof)
    receipt = ROOT / 'password-verification.json'
    if receipt.is_symlink():
        raise RuntimeError('Unexpected receipt path')
    receipt.write_text(json.dumps(result, indent=2) + '\n')
    receipt.chmod(0o600)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
