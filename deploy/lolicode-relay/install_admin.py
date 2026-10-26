#!/usr/bin/env python3
"""Prepare or activate the dedicated HTTPS panel; never replace the forum site."""
import argparse
from pathlib import Path

from migrate import remote

FILES = ('admin-nginx-http.conf', 'admin-nginx-https.conf',
         'admin-nginx-proxy.conf', 'admin-nginx-rate.conf')

INSTALL = r'''
owned()
run(['nginx', '-t'])
marker = ROOT / '.lolicode-relay-admin-owned'
installed = marker.is_file() and not marker.is_symlink() and marker.read_text().strip() == 'lolicode-relay-admin-v1'
allowed = ('admin-nginx-http.conf', 'admin-nginx-https.conf', 'admin-nginx-proxy.conf', 'admin-nginx-rate.conf')
for name, content in payload['files'].items():
    if name not in allowed:
        raise RuntimeError('Unexpected admin configuration member')
    target = ROOT / name
    if target.is_symlink() or (target.exists() and not installed):
        raise RuntimeError('Unowned admin configuration exists')
    if target.exists() and target.read_text() != content:
        shutil.copy2(target, ROOT / (name + '.previous'))
    target.write_text(content)
    target.chmod(0o600)

# Check both server blocks before DNS or certificate issuance is available.
validation = ROOT / 'admin-nginx-validation.conf'
if validation.is_symlink() or (validation.exists() and not installed):
    raise RuntimeError('Unowned nginx validation configuration exists')
tls = payload['files']['admin-nginx-https.conf'].replace(
    '/etc/letsencrypt/live/relay.lolicode.com/', '/etc/letsencrypt/live/lolicode.com/').replace(
    '/etc/nginx/snippets/lolicode-relay-admin-proxy.conf', str(ROOT / 'admin-nginx-proxy.conf'))
validation.write_text('events {}\nhttp {\n' + payload['files']['admin-nginx-rate.conf'] +
                      payload['files']['admin-nginx-http.conf'] + tls + '\n}\n')
validation.chmod(0o600)
run(['nginx', '-t', '-c', str(validation)])
marker.write_text('lolicode-relay-admin-v1\n')
marker.chmod(0o600)
if not payload['activate']:
    emit({'prepared': True, 'nginx_syntax_valid': True, 'public_admin_enabled': False,
          'required_dns': {'type': 'A', 'name': 'relay.lolicode.com', 'value': '43.108.86.66', 'proxy': False}})
    sys.exit(0)

addresses = {item[4][0] for item in socket.getaddrinfo('relay.lolicode.com', 443, type=socket.SOCK_STREAM)}
if addresses != {'43.108.86.66'}:
    raise RuntimeError('DNS must point only to 43.108.86.66 with Cloudflare proxy disabled')
network = json.loads(run(['docker', 'network', 'inspect', 'lolicode-relay_relay']))[0]
gateway = network['IPAM']['Config'][0]['Gateway']
import ipaddress
ipaddress.ip_address(gateway)
public_marker = ROOT / '.lolicode-relay-admin-public-owned'
public_installed = (public_marker.is_file() and not public_marker.is_symlink()
                    and public_marker.read_text().strip() == 'lolicode-relay-admin-public-v1')
if public_marker.exists() and not public_installed:
    raise RuntimeError('Unrecognized public admin ownership')
site = pathlib.Path('/etc/nginx/sites-available/lolicode-relay-admin.conf')
enabled = pathlib.Path('/etc/nginx/sites-enabled/lolicode-relay-admin.conf')
proxy = pathlib.Path('/etc/nginx/snippets/lolicode-relay-admin-proxy.conf')
rate = pathlib.Path('/etc/nginx/conf.d/lolicode-relay-admin-rate.conf')
for path in (site, proxy, rate):
    if path.is_symlink() or (path.exists() and not public_installed):
        raise RuntimeError('Unowned public admin configuration exists: ' + str(path))
if enabled.is_symlink():
    if not public_installed or enabled.resolve() != site:
        raise RuntimeError('Unowned public admin site link')
elif enabled.exists():
    raise RuntimeError('Unexpected enabled admin site')
env_file = ROOT / '.env'
compose_file = ROOT / 'compose.yaml'
if env_file.is_symlink() or compose_file.is_symlink():
    raise RuntimeError('Unexpected relay configuration symlink')
original_compose = compose_file.read_text()
for key in ('RELAY_SESSION_COOKIE_SECURE', 'RELAY_SESSION_COOKIE_TRUSTED_URL', 'RELAY_TRUSTED_PROXIES'):
    if key not in original_compose:
        raise RuntimeError('Install the parameterized compose.yaml before activating the public panel')
run(['python3', str(ROOT / 'backup.py')])
original_env = env_file.read_text()
previous = {str(path): path.read_text() if path.exists() else None for path in (site, proxy, rate)}
was_enabled = enabled.is_symlink()
try:
    proxy.write_text(payload['files']['admin-nginx-proxy.conf'])
    rate.write_text(payload['files']['admin-nginx-rate.conf'])
    # Expose only HTTP validation until a valid certificate is installed.
    site.write_text(payload['files']['admin-nginx-http.conf'])
    for path in (site, proxy, rate):
        path.chmod(0o644)
    if not was_enabled:
        enabled.symlink_to(site)
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    renewal = pathlib.Path('/etc/letsencrypt/renewal/lolicode.com.conf').read_text()
    match = re.search(r'^account\s*=\s*([a-fA-F0-9]+)\s*$', renewal, re.MULTILINE)
    if not match:
        raise RuntimeError('An existing registered certificate account is required')
    run(['certbot', 'certonly', '--webroot', '--webroot-path', '/var/www/acme',
         '--cert-name', 'relay.lolicode.com', '--domain', 'relay.lolicode.com',
         '--account', match.group(1), '--non-interactive', '--key-type', 'ecdsa',
         '--keep-until-expiring', '--deploy-hook', 'systemctl reload nginx'])
    settings = {'RELAY_SESSION_COOKIE_SECURE': 'true',
                'RELAY_SESSION_COOKIE_TRUSTED_URL': 'https://relay.lolicode.com',
                'RELAY_TRUSTED_PROXIES': gateway + '/32'}
    lines = [line for line in original_env.splitlines() if line.split('=', 1)[0] not in settings]
    env_file.write_text('\n'.join(lines) + '\n' + ''.join(key + '=' + value + '\n' for key, value in settings.items()))
    env_file.chmod(0o600)
    run(COMPOSE + ['config', '--quiet'])
    run(COMPOSE + ['up', '-d', '--no-deps', '--wait', 'new-api'])
    site.write_text(payload['files']['admin-nginx-http.conf'] + '\n' + payload['files']['admin-nginx-https.conf'])
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    # Curl verifies the actual certificate while avoiding stale local DNS caches.
    # A graceful nginx reload returns before replacement workers are ready.
    status = json.loads(run(['curl', '--fail', '--silent', '--show-error', '--max-time', '10',
                             '--retry', '6', '--retry-all-errors', '--retry-delay', '1',
                             '--resolve', 'relay.lolicode.com:443:127.0.0.1',
                             'https://relay.lolicode.com/api/status']))
    if status.get('success') is not True:
        raise RuntimeError('Public panel health check failed')
    for route in ('/v1/models', '/v1/chat/completions', '/v1beta/models', '/pg/chat/completions', '/mj/image/1', '/fast/mj/image/1'):
        code = run(['curl', '--silent', '--show-error', '--max-time', '10', '--output', '/dev/null',
                    '--write-out', '%{http_code}', '--resolve', 'relay.lolicode.com:443:127.0.0.1',
                    'https://relay.lolicode.com' + route]).decode()
        if code != '404':
            raise RuntimeError('Public inference route was not blocked: ' + route)
    public_marker.write_text('lolicode-relay-admin-public-v1\n')
    public_marker.chmod(0o600)
except Exception:
    env_file.write_text(original_env)
    env_file.chmod(0o600)
    for filename, content in previous.items():
        path = pathlib.Path(filename)
        if content is None:
            if path.exists():
                path.unlink()
        else:
            path.write_text(content)
            path.chmod(0o644)
    if not was_enabled and enabled.is_symlink() and enabled.resolve(strict=False) == site:
        enabled.unlink()
    run(COMPOSE + ['up', '-d', '--no-deps', '--wait', 'new-api'])
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    raise
emit({'public_admin_enabled': True, 'url': 'https://relay.lolicode.com',
      'secure_cookies': True, 'direct_inference_blocked': True,
      'public_inference_base': 'https://lolicode.com/relay/v1'})
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--activate', action='store_true', help='Requires the exact DNS record; obtains TLS and activates the panel')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    payload = {'activate': args.activate,
               'files': {name: (here / name).read_text(encoding='utf8') for name in FILES}}
    print(remote(args.host, INSTALL, payload, timeout=600))


if __name__ == '__main__':
    main()
