#!/usr/bin/env python3
"""Publish only the relay portal and a stylesheet for the existing admin app."""
import argparse
from pathlib import Path
from migrate import remote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    payload = {'files': {name: (here / 'portal' / name).read_text(encoding='utf8')
                         for name in ('index.html', 'portal.css', 'portal.js', 'portal-host.js', 'admin-theme.css',
                                      'account.html', 'account.css', 'account.js', 'public-account.css', 'public-account.js')},
               'nginx': (here / 'admin-nginx-https.conf').read_text(encoding='utf8'),
               'backup': (here / 'backup.py').read_text(encoding='utf8'),
               'homepage': 'https://relay.lolicode.com/relay-assets/index.html?v=20261021-6'}
    print(remote(args.host, r'''
owned()
marker = ROOT / '.lolicode-relay-portal-owned'
web = pathlib.Path('/var/www/lolicode-relay-public')
source = ROOT / 'portal-source'
site = pathlib.Path('/etc/nginx/sites-available/lolicode-relay-admin.conf')
owned_marker = ROOT / '.lolicode-relay-admin-public-owned'
if owned_marker.is_symlink() or owned_marker.read_text().strip() != 'lolicode-relay-admin-public-v1':
    raise RuntimeError('An owned active admin deployment is required')
if marker.is_symlink() or (marker.exists() and marker.read_text().strip() != 'lolicode-relay-portal-v1'):
    raise RuntimeError('Unrecognized relay portal ownership')
if web.is_symlink() or source.is_symlink() or site.is_symlink():
    raise RuntimeError('Unexpected relay portal symlink')
if (web.exists() or source.exists()) and not marker.exists():
    raise RuntimeError('An unowned public portal folder already exists')
nginx_source = ROOT / 'admin-nginx-https.conf'
original_site = site.read_text()
expected_site = (ROOT / 'admin-nginx-http.conf').read_text() + '\n' + nginx_source.read_text()
if original_site != expected_site:
    raise RuntimeError('Admin site has operator changes; preserve them for review')
sys.path.insert(0, str(ROOT))
from bootstrap import Dashboard
client = Dashboard()
client.login()
old_home = client.request('/api/home_page_content') or ''
if old_home and not old_home.startswith('https://relay.lolicode.com/relay-assets/index.html?'):
    raise RuntimeError('Preserve the operator-configured homepage before changing it')
backup = ROOT / 'backup.py'
if backup.is_symlink():
    raise RuntimeError('Unexpected backup script path')
if backup.read_text() != payload['backup']:
    shutil.copy2(backup, ROOT / 'backup.py.previous')
    backup.write_text(payload['backup'])
    backup.chmod(0o600)
run(['python3', str(backup)])
web.mkdir(mode=0o755, exist_ok=True)
web.chmod(0o755)
source.mkdir(mode=0o700, exist_ok=True)
previous_paths = [parent / name for parent in (web, source) for name in payload['files']] + [nginx_source]
if any(path.is_symlink() for path in previous_paths):
    raise RuntimeError('Unexpected portal asset symlink')
previous = {str(path): path.read_text() if path.exists() else None for path in previous_paths}
homepage_mutated = False
try:
    for name, content in payload['files'].items():
        if name not in ('index.html', 'portal.css', 'portal.js', 'portal-host.js', 'admin-theme.css',
                        'account.html', 'account.css', 'account.js', 'public-account.css', 'public-account.js'):
            raise RuntimeError('Unexpected portal member')
        for parent, mode in ((web, 0o644), (source, 0o600)):
            target = parent / name
            if target.is_symlink():
                raise RuntimeError('Unexpected portal asset symlink')
            target.write_text(content)
            target.chmod(mode)
    site.write_text((ROOT / 'admin-nginx-http.conf').read_text() + '\n' + payload['nginx'])
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    homepage_mutated = True
    client.request('/api/option/', {'key': 'HomePageContent', 'value': payload['homepage']}, 'PUT')
    import urllib.request, time
    for attempt in range(15):
        with urllib.request.urlopen('https://relay.lolicode.com/', timeout=10) as response:
            page = response.read().decode()
        if '/relay-assets/portal-host.js?v=20261021-6' in page: break
        if attempt == 14: raise RuntimeError('Portal did not become ready')
        time.sleep(0.2)
    for name in payload['files']:
        with urllib.request.urlopen('https://relay.lolicode.com/relay-assets/' + name, timeout=10) as response:
            if response.read().decode() != payload['files'][name]:
                raise RuntimeError('Public portal asset mismatch: ' + name)
    with urllib.request.urlopen('https://relay.lolicode.com/community-status', timeout=10) as response:
        if response.headers.get('Access-Control-Allow-Origin') != '*':
            raise RuntimeError('Public status is unavailable to the homepage sandbox')
        status = json.load(response)
    if set(status) != {'ready', 'modelCount', 'dailyRequests', 'dailyTokens', 'timezone', 'resetsAt',
                       'limits', 'trialEndsAt'}:
        raise RuntimeError('Unexpected public status fields')
    with urllib.request.urlopen('https://relay.lolicode.com/sign-in?admin=1', timeout=10) as response:
        if '/relay-assets/admin-theme.css' not in response.read().decode():
            raise RuntimeError('Admin stylesheet was not attached')
    if client.request('/api/home_page_content') != payload['homepage']:
        raise RuntimeError('Official homepage customization did not persist')
    nginx_source.write_text(payload['nginx'])
    nginx_source.chmod(0o600)
    marker.write_text('lolicode-relay-portal-v1\n')
    marker.chmod(0o600)
except Exception:
    if homepage_mutated:
        client.request('/api/option/', {'key': 'HomePageContent', 'value': old_home}, 'PUT')
    site.write_text(original_site)
    for filename, content in previous.items():
        path = pathlib.Path(filename)
        if content is None:
            if path.exists(): path.unlink()
        else:
            path.write_text(content)
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    raise
emit({'portal': 'https://relay.lolicode.com/', 'admin': 'https://relay.lolicode.com/sign-in?admin=1',
      'brand': 'LoliCode cherry and cream', 'official_navigation': True,
      'status': status, 'nginx_valid': True})
''', payload))


if __name__ == '__main__':
    main()
