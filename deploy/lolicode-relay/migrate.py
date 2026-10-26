#!/usr/bin/env python3
"""Move an empty relay foundation between trusted SSH hosts, preserving state.

No credentials or backup bytes are written to the local machine or printed.
The destination must be empty; an existing deployment is never overwritten.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
COMMON = r'''
import hashlib, io, json, os, pathlib, re, shutil, socket, subprocess, sys, tarfile
from datetime import datetime, timezone
ROOT = pathlib.Path('/opt/lolicode-relay')
OWNED = 'lolicode-relay-v1'
COMPOSE = ['docker', 'compose', '--project-directory', str(ROOT), '-f', str(ROOT / 'compose.yaml')]
os.umask(0o077)
def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=300, **kwargs).stdout
def owned():
    if ROOT.is_symlink() or ROOT.resolve() != ROOT:
        raise RuntimeError('Unexpected deployment path')
    marker = ROOT / '.lolicode-relay-owned'
    if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != OWNED:
        raise RuntimeError('Unrecognized deployment ownership')
def counts():
    pg = COMPOSE + ['exec', '-T', 'postgres', 'psql', '-U', 'lolicode_relay', '-d', 'lolicode_relay', '-Atc']
    tables = run(pg + ["SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"]).decode().splitlines()
    return {name: int(run(pg + ['SELECT count(*) FROM "' + name.replace('"', '""') + '";'])) for name in tables}
def emit(value):
    print(json.dumps(value))
'''


def ssh(host, command, *, data=None, timeout=600):
    result = subprocess.run([
        'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=4', host, command,
    ], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # The remote scripts never print credential values. Do not include stdin.
        raise RuntimeError(host + ': ' + result.stderr.decode(errors='replace')[-3500:])
    return result.stdout


def remote(host, code, payload=None, timeout=600):
    script = COMMON + '\npayload = json.loads(' + repr(json.dumps(payload or {})) + ')\n' + code
    return json.loads(ssh(host, 'python3 -', data=script.encode(), timeout=timeout))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default='tools')
    parser.add_argument('--destination', default='lolicode')
    args = parser.parse_args()
    for host in (args.source, args.destination):
        if not re.fullmatch(r'[a-zA-Z0-9_.@-]+', host) or host.startswith('-'):
            parser.error('Invalid trusted SSH alias')
    source = args.source
    destination = args.destination
    preflight = r'''
owned()
from bootstrap import Dashboard
client = Dashboard()
client.login()
if client.request('/api/channel/')['total'] != 0:
    raise RuntimeError('This foundation migration refuses real upstream channels')
pg = COMPOSE + ['exec', '-T', 'postgres', 'psql', '-U', 'lolicode_relay', '-d', 'lolicode_relay', '-Atc']
if run(pg + ['SELECT count(*) FROM users WHERE deleted_at IS NULL;']).strip() != b'1':
    raise RuntimeError('This foundation migration requires only the administrator account')
if run(pg + ['SELECT count(*) FROM tokens WHERE deleted_at IS NULL;']).strip() != b'0':
    raise RuntimeError('This foundation migration refuses active tokens')
emit({'machine': pathlib.Path('/etc/machine-id').read_text().strip(),
      'images': json.loads((ROOT / 'images.lock.json').read_text())})
'''
    # Add only the known installed module directory to the remote import path.
    origin = remote(source, "sys.path.insert(0, str(ROOT))\n" + preflight)
    target = remote(destination, r'''
if ROOT.exists() or ROOT.is_symlink():
    raise RuntimeError('Destination directory already exists; inspect before any recovery')
for unit in ('lolicode-relay.service', 'lolicode-relay-backup.service', 'lolicode-relay-backup.timer'):
    if (pathlib.Path('/etc/systemd/system') / unit).exists():
        raise RuntimeError('Destination unit already exists: ' + unit)
run(['docker', 'compose', 'version'])
if run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=lolicode-relay']).strip():
    raise RuntimeError('Destination already has relay containers')
for volume in ('lolicode-relay_postgres-data', 'lolicode-relay_redis-data'):
    if subprocess.run(['docker', 'volume', 'inspect', volume], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode == 0:
        raise RuntimeError('Destination relay volume already exists')
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 13000))
if shutil.disk_usage('/opt').free < 5 * 1024**3:
    raise RuntimeError('Destination needs at least 5 GiB free disk')
for key in ('new_api', 'postgres', 'redis'):
    image = payload['images'][key]
    run(['docker', 'image', 'inspect', image])
emit({'machine': pathlib.Path('/etc/machine-id').read_text().strip()})
''', {'images': origin['images']})
    if origin['machine'] == target['machine']:
        raise RuntimeError('Source and destination are the same host')
    local_images = json.loads((HERE / 'images.lock.json').read_text())
    if local_images != origin['images']:
        raise RuntimeError('Local pinned images differ from the source; inspect before migration')
    print('Preflight passed; preserving source credentials, settings and database.', flush=True)
    frozen = False
    validated = False
    try:
        frozen = True
        export = remote(source, r'''
owned()
run(['systemctl', 'stop', 'lolicode-relay-backup.timer'])
run(COMPOSE + ['stop', 'new-api'])
receipt = json.loads(run(['python3', str(ROOT / 'backup.py')]))
archive = pathlib.Path(receipt['backup'])
if archive.parent.resolve() != (ROOT / 'backups').resolve() or not re.fullmatch(r'relay-\d{8}T\d{12}Z\.tar\.gz', archive.name):
    raise RuntimeError('Unexpected backup path')
emit({'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
      'table_counts': counts()})
''')
        name = export['archive']
        if not re.fullmatch(r'relay-\d{8}T\d{12}Z\.tar\.gz', name):
            raise RuntimeError('Unexpected exported filename')
        archive = ssh(source, 'cat /opt/lolicode-relay/backups/' + name)
        if hashlib.sha256(archive).hexdigest() != export['sha256']:
            raise RuntimeError('Backup transfer checksum mismatch')
        import base64
        staged = remote(destination, r'''
import base64
if ROOT.exists() or ROOT.is_symlink():
    raise RuntimeError('Destination changed during preflight')
archive = base64.b64decode(payload['archive_bytes'], validate=True)
if len(archive) > 64 * 1024**2 or hashlib.sha256(archive).hexdigest() != payload['sha256']:
    raise RuntimeError('Backup size or checksum rejected')
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as backup:
    members = backup.getmembers()
    if sum(member.size for member in members) > 512 * 1024**2:
        raise RuntimeError('Uncompressed backup exceeds foundation limit')
    names = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or member.name in names:
            raise RuntimeError('Unsafe or duplicate archive path')
        names.add(member.name)
        if path.parts[0] not in ('.env', 'admin-credentials.json', 'compose.yaml', 'images.lock.json',
                                 '.lolicode-relay-owned', 'data', 'database.dump'):
            raise RuntimeError('Unexpected archive entry')
        if path.parts[0] != 'data' and len(path.parts) != 1:
            raise RuntimeError('Unexpected nested archive entry')
        if not (member.isfile() or (member.isdir() and path.parts[0] == 'data')):
            raise RuntimeError('Archive links or special entries rejected')
    for required in ('.env', 'admin-credentials.json', 'images.lock.json', '.lolicode-relay-owned', 'database.dump'):
        if required not in names or not backup.getmember(required).isfile():
            raise RuntimeError('Required backup member missing')
    if backup.extractfile('.lolicode-relay-owned').read().decode().strip() != OWNED:
        raise RuntimeError('Backup ownership rejected')
    if json.load(backup.extractfile('images.lock.json')) != payload['images']:
        raise RuntimeError('Backup image manifest differs')
    env = dict(line.split('=', 1) for line in backup.extractfile('.env').read().decode().splitlines() if line)
    for env_key, image_key in (('NEW_API_IMAGE', 'new_api'), ('POSTGRES_IMAGE', 'postgres'), ('REDIS_IMAGE', 'redis')):
        if env.get(env_key) != payload['images'][image_key]:
            raise RuntimeError('Backup environment uses unexpected images')
    ROOT.mkdir(mode=0o700)
    (ROOT / '.lolicode-relay-owned').write_text(OWNED + '\n')
    for member in members:
        if member.name not in ('.env', 'admin-credentials.json') and pathlib.PurePosixPath(member.name).parts[0] != 'data':
            continue
        target = ROOT / member.name
        if not target.resolve().is_relative_to(ROOT):
            raise RuntimeError('Archive destination escaped root')
        if member.isdir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
        else:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(backup.extractfile(member).read())
            target.chmod(0o600)
backups = ROOT / 'backups'
backups.mkdir(mode=0o700)
with (backups / payload['archive']).open('xb') as output:
    output.write(archive)
receipt = {key: value for key, value in payload.items() if key != 'archive_bytes'}
receipt['phase'] = 'staged'
(ROOT / 'migration.json').write_text(json.dumps(receipt, indent=2) + '\n')
emit({'staged': True, 'checksum_verified': True})
''', {**export, 'archive_bytes': base64.b64encode(archive).decode(),
      'images': origin['images'], 'source': source, 'destination': destination})
        del archive
        assert staged['checksum_verified'] is True
        print('Backup transferred with SHA-256 verification; preparing destination services.', flush=True)
        subprocess.run([sys.executable, str(HERE / 'deploy.py'), '--host', destination,
                        '--resume', '--prepare-only'], check=True, timeout=180)
        restored = remote(destination, r'''
owned()
receipt = json.loads((ROOT / 'migration.json').read_text())
if receipt['phase'] != 'staged':
    raise RuntimeError('Destination is not an unstarted migration stage')
run(COMPOSE + ['config', '--quiet'])
run(COMPOSE + ['up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'redis'])
pg = COMPOSE + ['exec', '-T', 'postgres']
if run(pg + ['psql', '-U', 'lolicode_relay', '-d', 'lolicode_relay', '-Atc',
             "SELECT count(*) FROM pg_tables WHERE schemaname='public';"]).strip() != b'0':
    raise RuntimeError('Refusing to restore over existing database tables')
archive = ROOT / 'backups' / receipt['archive']
if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt['sha256']:
    raise RuntimeError('Stored archive checksum mismatch')
with tarfile.open(archive, 'r:gz') as backup:
    dump = backup.extractfile('database.dump').read()
run(pg + ['pg_restore', '-U', 'lolicode_relay', '-d', 'lolicode_relay',
          '--exit-on-error', '--no-owner'], input=dump)
actual = counts()
if actual != receipt['table_counts']:
    raise RuntimeError('Restored database table counts differ from the source')
receipt['phase'] = 'restored'
receipt['database_counts_match'] = True
(ROOT / 'migration.json').write_text(json.dumps(receipt, indent=2) + '\n')
run(['systemctl', 'enable', '--now', 'lolicode-relay.service'])
run(['systemctl', 'enable', '--now', 'lolicode-relay-backup.timer'])
emit({'restored': True, 'database_counts_match': True, 'tables': len(actual)})
''', timeout=600)
        assert restored['database_counts_match'] is True
        print('All database table counts match. Running local-mock gateway and backup checks.', flush=True)
        verification = remote(destination, r'''
owned()
report = json.loads(run(['python3', str(ROOT / 'verify.py')]))
emit(report)
''', timeout=600)
        assert verification['backup_restore_verified'] is True
        validated = True
        remote(source, r'''
owned()
run(['systemctl', 'disable', '--now', 'lolicode-relay-backup.timer', 'lolicode-relay.service'])
receipt = {'destination': payload['destination'], 'archive': payload['archive'],
           'sha256': payload['sha256'], 'migrated_at': datetime.now(timezone.utc).isoformat(),
           'services_disabled': True, 'data_retained': True}
(ROOT / 'MIGRATED-TO.json').write_text(json.dumps(receipt, indent=2) + '\n')
emit({'source_disabled': True, 'data_retained': True})
''', {**export, 'destination': destination})
        receipt = remote(destination, r'''
owned()
receipt = json.loads((ROOT / 'migration.json').read_text())
receipt['phase'] = 'complete'
receipt['completed_at'] = datetime.now(timezone.utc).isoformat()
receipt['source_disabled'] = True
receipt['verification'] = json.loads((ROOT / 'verification.json').read_text())
(ROOT / 'migration.json').write_text(json.dumps(receipt, indent=2) + '\n')
emit({'migrated': True, 'source': receipt['source'], 'destination': receipt['destination'],
      'checksum_verified': True, 'database_counts_match': True, 'source_disabled': True,
      'verification': receipt['verification']})
''')
        print(json.dumps(receipt, indent=2))
    except Exception:
        if frozen and not validated:
            print('Migration failed; stopping the destination and restoring the source service.', file=sys.stderr)
            # Never discard the destination database or backup during recovery.
            try:
                remote(destination, r'''
if ROOT.is_dir() and not ROOT.is_symlink() and (ROOT / '.lolicode-relay-owned').is_file():
    owned()
    subprocess.run(['systemctl', 'disable', '--now', 'lolicode-relay-backup.timer',
                    'lolicode-relay.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if (ROOT / 'compose.yaml').is_file():
        run(COMPOSE + ['stop'])
emit({'destination_stopped': True})
''')
            except Exception as error:
                print('Destination stop needs inspection: ' + str(error), file=sys.stderr)
            remote(source, r'''
owned()
run(['systemctl', 'enable', 'lolicode-relay.service'])
run(['systemctl', 'restart', 'lolicode-relay.service'])
run(['systemctl', 'enable', '--now', 'lolicode-relay-backup.timer'])
emit({'source_restored': True})
''')
        elif validated:
            print('Destination passed verification. Keep it running; inspect source finalization before retrying.', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
