#!/usr/bin/env python3
"""Install the owned identity bridge and add its HTTPS route without replacing the site."""
import argparse
from pathlib import Path
from migrate import remote

FILES = ('bridge.py', 'web_account.py', 'public_settings.py', 'test_public_settings.py', 'verify_public_settings.py', 'test_web_account.py', 'bridge-policy.json', 'test_bridge.py', 'lolicode-relay-bridge.service',
         'bridge-nginx-location.conf', 'bridge-nginx-rate.conf', 'forum_fixture.php', 'verify_bridge.py', 'manage_quota.py')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--prepare-only', action='store_true', help='Stage files/units before provisioning the service identity')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    payload = {'prepare_only': args.prepare_only,
               'files': {name: (here / name).read_text(encoding='utf8') for name in FILES}}
    result = remote(args.host, r'''
owned()
run(['nginx', '-t'])
run(['python3', str(ROOT / 'backup.py')])
marker = ROOT / '.lolicode-relay-bridge-owned'
installed = marker.is_file() and not marker.is_symlink() and marker.read_text().strip() == 'lolicode-relay-bridge-v1'
for name, content in payload['files'].items():
    if name not in ('bridge.py', 'web_account.py', 'public_settings.py', 'test_public_settings.py', 'verify_public_settings.py', 'test_web_account.py', 'bridge-policy.json', 'test_bridge.py', 'lolicode-relay-bridge.service',
                    'bridge-nginx-location.conf', 'bridge-nginx-rate.conf', 'forum_fixture.php', 'verify_bridge.py', 'manage_quota.py'):
        raise RuntimeError('Unexpected bridge member')
    target = ROOT / name
    if target.is_symlink():
        raise RuntimeError('Unexpected bridge symlink')
    if name == 'bridge-policy.json' and target.exists():
        continue  # Preserve operator model allowlists and chosen daily limits.
    if target.exists() and target.read_text() != content:
        shutil.copy2(target, ROOT / (name + '.previous'))
    target.write_text(content)
    target.chmod(0o600)
state = ROOT / 'bridge-state'
if state.is_symlink():
    raise RuntimeError('Unexpected bridge state symlink')
state.mkdir(mode=0o700, exist_ok=True)
run(['python3', '-m', 'unittest', '-v', 'test_bridge', 'test_web_account', 'test_public_settings'], cwd=ROOT)
unit = pathlib.Path('/etc/systemd/system/lolicode-relay-bridge.service')
if unit.is_symlink() or (unit.exists() and not installed):
    raise RuntimeError('Unowned bridge service exists')
unit.write_text(payload['files']['lolicode-relay-bridge.service'])
unit.chmod(0o644)
location = pathlib.Path('/etc/nginx/snippets/lolicode-relay-location.conf')
rate = pathlib.Path('/etc/nginx/conf.d/lolicode-relay-rate.conf')
site = pathlib.Path('/etc/nginx/sites-enabled/lolicode.conf').resolve()
if site != pathlib.Path('/etc/nginx/sites-available/lolicode.conf'):
    raise RuntimeError('Unexpected website configuration path')
include = '    include /etc/nginx/snippets/lolicode-relay-location.conf;'
original = site.read_text()
if include not in original and original.count('    server_name lolicode.com;') != 1:
    raise RuntimeError('Ambiguous website HTTPS server block')
backup = ROOT / 'nginx-lolicode.pre-bridge.conf'
if not backup.exists():
    backup.write_text(original)
    backup.chmod(0o600)
previous = {}
for path, name in ((location, 'bridge-nginx-location.conf'), (rate, 'bridge-nginx-rate.conf')):
    if path.is_symlink() or (path.exists() and not installed):
        raise RuntimeError('Unowned nginx bridge configuration exists')
    previous[str(path)] = path.read_text() if path.exists() else None
    path.write_text(payload['files'][name])
    path.chmod(0o644)
if include not in original:
    site.write_text(original.replace('    server_name lolicode.com;', '    server_name lolicode.com;\n' + include, 1))
try:
    run(['nginx', '-t'])
    run(['systemctl', 'daemon-reload'])
    if payload['prepare_only']:
        marker.write_text('lolicode-relay-bridge-v1\n')
        marker.chmod(0o600)
        emit({'prepared': True, 'services_started': False})
        sys.exit(0)
    run(['systemctl', 'enable', 'lolicode-relay-bridge.service'])
    import sqlite3
    database = state / 'bridge.sqlite3'
    if database.exists():
        with sqlite3.connect(database) as db:
            if db.execute("SELECT count(*) FROM requests WHERE state='pending'").fetchone()[0]:
                raise RuntimeError('Active inference exists; retry deployment after it completes')
    run(['systemctl', 'restart', 'lolicode-relay-bridge.service'])
    import urllib.request, time
    for attempt in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:13001/health', timeout=3) as response:
                if json.load(response)['ok'] is True:
                    break
        except OSError:
            if attempt == 29:
                raise
            time.sleep(1)
    run(['systemctl', 'reload', 'nginx'])
except Exception:
    site.write_text(original)
    for filename, content in previous.items():
        path = pathlib.Path(filename)
        if content is None:
            path.unlink()
        else:
            path.write_text(content)
    run(['nginx', '-t'])
    raise
marker.write_text('lolicode-relay-bridge-v1\n')
emit({'installed': True, 'public_base': 'https://lolicode.com/relay/v1',
      'daily_requests': json.loads((ROOT / 'bridge-policy.json').read_text())['daily_requests'],
      'daily_tokens': json.loads((ROOT / 'bridge-policy.json').read_text())['daily_tokens']})
''', payload, timeout=600)
    print(result)


if __name__ == '__main__':
    main()
