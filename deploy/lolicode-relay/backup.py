#!/usr/bin/env python3
"""Root-only PostgreSQL + application/config backup, retaining seven archives."""
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sqlite3
import tarfile
import tempfile

ROOT = Path('/opt/lolicode-relay')
COMPOSE = ['docker', 'compose', '--project-directory', str(ROOT), '-f', str(ROOT / 'compose.yaml')]


def main():
    if ROOT.is_symlink() or ROOT.resolve() != ROOT:
        raise RuntimeError('Unexpected deployment path')
    os.umask(0o077)
    backup_dir = ROOT / 'backups'
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    if backup_dir.is_symlink():
        raise RuntimeError('Unexpected backup symlink')
    with (backup_dir / '.backup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        archive = backup_dir / ('relay-' + stamp + '.tar.gz')
        temporary_archive = archive.with_suffix('.partial')
        with tempfile.TemporaryDirectory(prefix='.stage-', dir=backup_dir) as stage:
            dump = Path(stage) / 'database.dump'
            with dump.open('wb') as output:
                subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'pg_dump',
                               '-U', 'lolicode_relay', '-d', 'lolicode_relay', '-Fc'],
                               stdout=output, check=True, timeout=180)
            with dump.open('rb') as source:
                subprocess.run(COMPOSE + ['exec', '-T', 'postgres', 'pg_restore', '--list'],
                               stdin=source, stdout=subprocess.DEVNULL, check=True, timeout=60)
            bridge_snapshot = None
            bridge_state = ROOT / 'bridge-state'
            bridge_database = bridge_state / 'bridge.sqlite3'
            if bridge_state.is_symlink() or bridge_database.is_symlink():
                raise RuntimeError('Unexpected bridge backup symlink')
            if bridge_database.is_file():
                bridge_snapshot = Path(stage) / 'bridge.sqlite3'
                with sqlite3.connect(bridge_database) as source_db, sqlite3.connect(bridge_snapshot) as target_db:
                    source_db.backup(target_db)
                    if target_db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Bridge backup integrity check failed')
            with tarfile.open(temporary_archive, 'w:gz') as output:
                output.add(dump, arcname='database.dump')
                if bridge_snapshot is not None:
                    output.add(bridge_snapshot, arcname='bridge-state/bridge.sqlite3')
                for name in ('.env', 'admin-credentials.json', 'bridge-service-credentials.json', 'bootstrap.py',
                             '.lolicode-bridge-service-owned', 'compose.yaml',
                             'images.lock.json', '.lolicode-relay-owned', 'data',
                             'bridge-policy.json', 'bridge.py', 'web_account.py', 'public_settings.py',
                             'bridge-state/public-settings.json', 'verify_public_settings.py',
                             'public-settings-verification.json', 'web-account-verification.json',
                             'homepage-account-verification.json',
                             'lolicode-relay-bridge.service',
                             'bridge-nginx-location.conf', 'bridge-nginx-rate.conf',
                             'admin-nginx-http.conf', 'admin-nginx-https.conf',
                             'admin-nginx-proxy.conf', 'admin-nginx-rate.conf',
                             '.lolicode-relay-admin-owned', '.lolicode-relay-admin-public-owned',
                             'portal-source', '.lolicode-relay-portal-owned',
                             'nginx-exploit.fixed.conf', 'README.md',
                             'desktop-channel-import.json', 'desktop-subscription-preview.json',
                             'glm-trial-activation.json', 'glm-trial-verification.json',
                             'forum-account-entry.js', '.lolicode-forum-account-entry-owned',
                             'forum-custom-header.pre-account-entry.html',
                             'account-entry-verification.json'):
                    path = ROOT / name
                    if path.is_symlink():
                        raise RuntimeError('Unexpected backup source symlink')
                    if path.exists():
                        output.add(path, arcname=name)
            os.replace(temporary_archive, archive)
        archives = sorted(path for path in backup_dir.iterdir()
                          if re.fullmatch(r'relay-\d{8}T\d{12}Z\.tar\.gz', path.name)
                          and path.is_file() and not path.is_symlink())
        for expired in archives[:-7]:
            if expired.parent.resolve() != backup_dir.resolve():
                raise RuntimeError('Unexpected retention target')
            expired.unlink()
        print(json.dumps({'backup': str(archive), 'bytes': archive.stat().st_size,
                          'retained': min(len(archives), 7), 'dump_readable': True}))


if __name__ == '__main__':
    main()
