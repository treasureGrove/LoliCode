#!/usr/bin/env python3
"""Install only /opt/lolicode-relay and its dedicated service/timer definitions."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

FILES = (
    'compose.yaml', 'images.lock.json', 'bootstrap.py', 'backup.py', 'verify.py', 'README.md',
    'lolicode-relay.service', 'lolicode-relay-backup.service',
    'lolicode-relay-backup.timer',
)

REMOTE_INSTALL = r'''
import json, os, pathlib, secrets, shutil, subprocess, sys
payload = json.load(sys.stdin)
root = pathlib.Path('/opt/lolicode-relay')
marker = root / '.lolicode-relay-owned'
owned = 'lolicode-relay-v1'
os.umask(0o077)
if root.is_symlink() or root.resolve() != root:
    raise RuntimeError('Unexpected target path')
if root.exists():
    if not payload['resume'] or not marker.is_file() or marker.read_text().strip() != owned:
        raise RuntimeError('Target already exists; inspect it, then use --resume only for this owned deployment')
else:
    root.mkdir(mode=0o700)
    marker.write_text(owned + '\n')
for name, content in payload['files'].items():
    if name not in ('compose.yaml', 'images.lock.json', 'bootstrap.py', 'backup.py', 'verify.py', 'README.md',
                    'lolicode-relay.service', 'lolicode-relay-backup.service', 'lolicode-relay-backup.timer'):
        raise RuntimeError('Unexpected deployment member')
    target = root / name
    if target.is_symlink():
        raise RuntimeError('Unexpected deployment symlink')
    if target.exists() and target.read_text() != content:
        shutil.copy2(target, root / (name + '.previous'))
    target.write_text(content, encoding='utf8')
    target.chmod(0o600)
for name in ('data', 'logs', 'backups'):
    path = root / name
    if path.is_symlink():
        raise RuntimeError('Unexpected state symlink')
    path.mkdir(mode=0o700, exist_ok=True)
images = json.loads((root / 'images.lock.json').read_text())
env_file = root / '.env'
if env_file.is_symlink():
    raise RuntimeError('Unexpected environment file symlink')
if not env_file.exists():
    config = {
        'NEW_API_IMAGE': images['new_api'],
        'POSTGRES_IMAGE': images['postgres'],
        'REDIS_IMAGE': images['redis'],
        'POSTGRES_PASSWORD': secrets.token_hex(32),
        'REDIS_PASSWORD': secrets.token_hex(32),
        'SESSION_SECRET': secrets.token_hex(32),
        'CRYPTO_SECRET': secrets.token_hex(32),
    }
    with env_file.open('x') as output:
        output.write(''.join(key + '=' + value + '\n' for key, value in config.items()))
    env_file.chmod(0o600)
credential_file = root / 'admin-credentials.json'
if credential_file.is_symlink():
    raise RuntimeError('Unexpected credential file symlink')
if not credential_file.exists():
    with credential_file.open('x') as output:
        json.dump({'username': 'relayadmin', 'password': 'Lc7!' + secrets.token_urlsafe(12)}, output)
    credential_file.chmod(0o600)
compose = ['docker', 'compose', '--project-directory', str(root), '-f', str(root / 'compose.yaml')]
subprocess.run(compose + ['config', '--quiet'], check=True)
for name in ('lolicode-relay.service', 'lolicode-relay-backup.service', 'lolicode-relay-backup.timer'):
    target = pathlib.Path('/etc/systemd/system') / name
    content = (root / name).read_text()
    if target.is_symlink() or (target.exists() and target.read_text() != content):
        raise RuntimeError('Existing service definition requires manual review: ' + name)
    target.write_text(content)
    target.chmod(0o644)
if shutil.which('logrotate'):
    target = pathlib.Path('/etc/logrotate.d/lolicode-relay')
    content = '/opt/lolicode-relay/logs/*.log {\n daily\n rotate 7\n maxsize 10M\n compress\n delaycompress\n missingok\n notifempty\n copytruncate\n su root root\n}\n'
    if target.is_symlink() or (target.exists() and target.read_text() != content):
        raise RuntimeError('Existing logrotate definition requires manual review')
    target.write_text(content)
    target.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
if payload['prepare_only']:
    print(json.dumps({'prepared': True, 'root': str(root), 'services_started': False}))
    sys.exit(0)
subprocess.run(['systemctl', 'enable', '--now', 'lolicode-relay.service'], check=True, timeout=240)
subprocess.run(['python3', str(root / 'bootstrap.py')], check=True, timeout=180)
subprocess.run(['systemctl', 'enable', '--now', 'lolicode-relay-backup.timer'], check=True)
subprocess.run(['systemctl', 'start', 'lolicode-relay-backup.service'], check=True, timeout=300)
print(json.dumps({'deployed': True, 'root': str(root), 'listen': '127.0.0.1:13000',
                  'admin_credentials': str(credential_file), 'version': images['new_api_version']}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode', help='Existing trusted SSH host alias')
    parser.add_argument('--resume', action='store_true', help='Resume only an existing marked deployment')
    parser.add_argument('--prepare-only', action='store_true', help='Install files and units without starting services')
    args = parser.parse_args()
    if not args.host or args.host.startswith('-') or any(c.isspace() for c in args.host):
        parser.error('Invalid SSH host alias')
    source = Path(__file__).resolve().parent
    payload = {'resume': args.resume, 'prepare_only': args.prepare_only,
               'files': {name: (source / name).read_text(encoding='utf8') for name in FILES}}
    subprocess.run([
        'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=12', args.host,
        'python3 -c ' + shlex.quote(REMOTE_INSTALL),
    ], input=json.dumps(payload).encode('utf8'), check=True, timeout=600)


if __name__ == '__main__':
    main()
