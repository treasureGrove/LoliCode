#!/usr/bin/env python3
"""Verify HTTPS admin sessions and isolation without calling any model upstream."""
import http.cookiejar
import json
from pathlib import Path
import socket
import ssl
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = Path('/opt/lolicode-relay')
ORIGIN = 'https://relay.lolicode.com'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    marker = ROOT / '.lolicode-relay-admin-public-owned'
    if ROOT.is_symlink() or marker.is_symlink() or marker.read_text().strip() != 'lolicode-relay-admin-public-v1':
        raise RuntimeError('An owned, active public admin deployment is required')
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar), urllib.request.ProxyHandler({}))
    anonymous = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    def request(path, *, body=None, token=None, origin=None, opener=client, base=ORIGIN):
        headers = {'Content-Type': 'application/json', 'User-Agent': 'LoliCodeRelayAcceptance/1.0'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if origin:
            headers['Origin'] = origin
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            response = opener.open(req, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            data = response.read(2 * 1024 * 1024)
            content_type = response.headers.get('Content-Type', '')
            parsed = json.loads(data) if 'application/json' in content_type and data else None
            return response.status, parsed, response.headers

    def success(path, **kwargs):
        code, data, _ = request(path, **kwargs)
        if code != 200 or not isinstance(data, dict) or data.get('success') is not True:
            raise RuntimeError('Admin acceptance failed: ' + path + ' (HTTP ' + str(code) + ')')
        return data.get('data')

    checks = {}
    success('/api/status')
    checks['public_https_status'] = True
    code, _, headers = request('/', opener=anonymous, base='http://relay.lolicode.com')
    assert code == 301 and headers.get('Location') == ORIGIN + '/'
    checks['http_redirects_to_https'] = True
    code, _, _ = request('/api/user/self', opener=anonymous)
    assert code in (401, 403)
    checks['anonymous_admin_rejected'] = True

    credential_file = ROOT / 'admin-credentials.json'
    if credential_file.is_symlink():
        raise RuntimeError('Unexpected credentials path')
    credential = json.loads(credential_file.read_text())
    login = success('/api/user/login', body=credential, origin=ORIGIN)
    token = login['access_token']
    logged_in = True
    try:
        user = success('/api/user/self', token=token)
        assert user['username'] == credential['username'] and user['role'] == 100
        checks['existing_admin_login'] = True
        cookies = {cookie.name: cookie for cookie in jar}
        refresh = cookies['new_api_refresh']
        assert refresh.secure and not refresh.domain_specified and refresh.path == '/api/user/auth'
        rest = {key.lower(): value for key, value in refresh._rest.items()}
        assert 'httponly' in rest and rest.get('samesite', '').lower() == 'strict'
        assert cookies['new_api_has_session'].secure
        checks['secure_http_only_host_cookie'] = True

        code, _, _ = request('/api/user/auth/refresh', body={}, origin='https://untrusted.example.invalid')
        assert code == 403
        checks['untrusted_origin_rejected'] = True
        refreshed = success('/api/user/auth/refresh', body={}, origin=ORIGIN)
        token = refreshed['access_token']
        assert success('/api/user/self', token=token)['id'] == user['id']
        checks['https_session_refresh'] = True

        options = {item['key']: item['value'] for item in success('/api/option/', token=token)}
        assert str(options['RegisterEnabled']).lower() == 'false'
        assert str(options['PasswordRegisterEnabled']).lower() == 'false'
        checks['separate_registration_disabled'] = True
        for route in ('/v1/models', '/v1/chat/completions', '/v1beta/models',
                      '/pg/chat/completions', '/mj/image/1', '/fast/mj/image/1'):
            for body in (None, {}):
                code, _, _ = request(route, body=body, token=token)
                assert code == 404
        checks['authenticated_inference_also_blocked'] = True

        success('/api/user/auth/logout', body={}, origin=ORIGIN)
        logged_in = False
        assert not any(cookie.name == 'new_api_refresh' for cookie in jar)
        checks['session_logout'] = True
    finally:
        if logged_in:
            try:
                request('/api/user/auth/logout', body={}, origin=ORIGIN)
            except OSError:
                pass

    for path, expected in (('/relay/health', 200), ('/relay/account', 401)):
        code, _, _ = request(path, opener=anonymous, base='https://lolicode.com')
        assert code == expected
    policy = json.loads((ROOT / 'bridge-policy.json').read_text())
    assert policy['daily_requests'] == 20 and policy['daily_tokens'] == 100000
    checks['original_account_bridge_and_daily_limits'] = True
    code, _, _ = request('/', opener=anonymous, base='https://lolicode.com')
    assert code == 200
    checks['original_website_healthy'] = True
    with socket.create_connection(('127.0.0.1', 443), timeout=10) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname='relay.lolicode.com') as tls:
            cert = tls.getpeercert()
            assert ('DNS', 'relay.lolicode.com') in cert['subjectAltName']
    renewal = Path('/etc/letsencrypt/renewal/relay.lolicode.com.conf').read_text()
    assert 'systemctl reload nginx' in renewal and 'webroot' in renewal
    checks['valid_certificate_and_renewal_hook'] = True
    result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'url': ORIGIN,
              'checks': checks, 'paid_upstream_requests': 0}
    receipt = ROOT / 'admin-verification.json'
    if receipt.is_symlink():
        raise RuntimeError('Unexpected acceptance receipt path')
    receipt.write_text(json.dumps(result, indent=2) + '\n')
    receipt.chmod(0o600)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
