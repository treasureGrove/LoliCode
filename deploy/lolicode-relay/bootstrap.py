#!/usr/bin/env python3
"""Initialize this owned, loopback-only instance; never print credentials."""
import atexit
import http.cookiejar
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path('/opt/lolicode-relay')
BASE = 'http://127.0.0.1:13000'


class Dashboard:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.token = None

    def request(self, path, data=None, method=None):
        headers = {'Content-Type': 'application/json', 'User-Agent': 'LoliCodeRelaySetup/1.0'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if path == '/api/user/auth/logout':
            headers['Origin'] = 'https://relay.lolicode.com'
        request = urllib.request.Request(
            BASE + path, data=None if data is None else json.dumps(data).encode(),
            headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError('Dashboard HTTP error: ' + str(exc.code)) from None
        if result.get('success') is not True:
            raise RuntimeError('Dashboard rejected operation: ' + str(result.get('message', 'unknown')))
        return result.get('data')

    def login(self):
        credential = json.loads((ROOT / 'admin-credentials.json').read_text())
        data = self.request('/api/user/login', credential)
        if not isinstance(data, dict) or not data.get('access_token'):
            raise RuntimeError('Login requires an additional verification step; credentials preserved')
        self.token = data['access_token']
        atexit.register(self.logout)
        return data

    def logout(self):
        if self.token:
            try:
                self.request('/api/user/auth/logout', {}, 'POST')
            except (OSError, RuntimeError, ValueError):
                pass  # Never expose credentials during best-effort process cleanup.
            finally:
                self.token = None


def main():
    client = Dashboard()
    for attempt in range(60):
        try:
            setup = client.request('/api/setup')
            break
        except (OSError, RuntimeError):
            if attempt == 59:
                raise
            time.sleep(2)
    if not setup['status']:
        if setup.get('root_init'):
            raise RuntimeError('Existing root user found in an uninitialized database; refusing replacement')
        credential = json.loads((ROOT / 'admin-credentials.json').read_text())
        client.request('/api/setup', {
            **credential, 'confirmPassword': credential['password'],
            'SelfUseModeEnabled': False, 'DemoSiteEnabled': False,
        })
    client.login()
    settings = {
        'SystemName': 'LoliCode Relay',
        'RegisterEnabled': 'false',
        'PasswordRegisterEnabled': 'false',
        'QuotaForNewUser': '0',
        'QuotaForInviter': '0',
        'QuotaForInvitee': '0',
        'LogConsumeEnabled': 'true',
    }
    for key, value in settings.items():
        client.request('/api/option/', {'key': key, 'value': value}, 'PUT')
    print(json.dumps({'initialized': True, 'registration': False,
                      'credentials_file': str(ROOT / 'admin-credentials.json')}))


if __name__ == '__main__':
    main()
