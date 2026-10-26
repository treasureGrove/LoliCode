#!/usr/bin/env python3
"""Install only this task's companion relay and additive nginx routes.

Run on the existing lolicode host with an audited source archive. No Firebase
credentials are configured, no existing app/container is restarted, and desktop
stable feeds are untouched. Failure preserves files and receipts for inspection.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tarfile
import time
import urllib.request

BASE = pathlib.Path('/opt/lolicode-companion')
SITE = pathlib.Path('/etc/nginx/sites-available/lolicode.conf')
MARKER = 'lolicode-android-companion-v1'
IMAGE = 'lolicode-companion:0.1.0-alpha.1'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*args):
    subprocess.run(args, check=True)


def write_new(path, data, mode=0o600):
    if path.exists():
        if path.read_bytes() != data:
            raise RuntimeError('Preserving different existing file: ' + str(path))
        return
    with path.open('xb') as output:
        output.write(data)
    path.chmod(mode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--site-sha256', required=True)
    parser.add_argument('--activate', action='store_true')
    args = parser.parse_args()
    archive = pathlib.Path(args.archive).resolve(strict=True)
    if digest(archive.read_bytes()) != args.sha256:
        raise RuntimeError('Source archive digest mismatch')
    before = SITE.read_bytes()
    if digest(before) != args.site_sha256:
        raise RuntimeError('Website changed; preserve state and re-plan')
    include = b'    include /etc/nginx/snippets/lolicode-companion.conf;'
    anchor = b'    include /etc/nginx/snippets/lolicode-relay-location.conf;'
    if include not in before and before.count(anchor) != 1:
        raise RuntimeError('Expected one existing HTTPS anchor')
    if BASE.exists() and (not (BASE / 'owner').is_file() or (BASE / 'owner').read_text() != MARKER):
        raise RuntimeError('Unowned companion directory exists')
    existing = subprocess.run(['docker', 'inspect', '--format', '{{index .Config.Labels "art.treasuregrove.owner"}}', 'lolicode-companion'], capture_output=True, text=True)
    if existing.returncode == 0:
        raise RuntimeError('Existing container preserved; use a separate reviewed update plan')
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            parts = pathlib.PurePosixPath(member.name).parts
            if not parts or '..' in parts or member.name.startswith('/') or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unexpected archive member')
            if parts[0] not in ('src', 'deploy') and member.name not in ('package.json', 'package-lock.json', 'Dockerfile'):
                raise RuntimeError('Unapproved source file')
        if sum(member.size for member in members) > 5 * 1024 * 1024:
            raise RuntimeError('Unexpected source archive size')
    if not args.activate:
        print(json.dumps({'plan': True, 'base': str(BASE), 'image': IMAGE, 'sourceSha256': args.sha256, 'siteSha256': args.site_sha256, 'publicWs': 'wss://lolicode.com/companion/ws', 'pushConfigured': False}))
        return
    BASE.mkdir(mode=0o700, exist_ok=True)
    write_new(BASE / 'owner', MARKER.encode())
    source = BASE / ('source-' + args.sha256[:16])
    source.mkdir(mode=0o700, exist_ok=True)
    with tarfile.open(archive, 'r:gz') as bundle:
        for member in bundle.getmembers():
            if member.isdir():
                continue
            target = source.joinpath(*pathlib.PurePosixPath(member.name).parts)
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            write_new(target, bundle.extractfile(member).read(), 0o644)
    state = BASE / 'state'
    if not state.exists():
        state.mkdir(mode=0o700)
        os.chown(state, 1000, 1000)
    if state.stat().st_uid != 1000 or state.stat().st_mode & 0o077:
        raise RuntimeError('State permissions are not private to the service user')
    run('docker', 'build', '--pull', '--label', 'art.treasuregrove.owner=' + MARKER, '-t', IMAGE, str(source))
    run('docker', 'run', '-d', '--name', 'lolicode-companion', '--label', 'art.treasuregrove.owner=' + MARKER, '--restart', 'unless-stopped', '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2', '--mount', 'type=bind,src=' + str(state) + ',dst=/var/lib/lolicode-companion', IMAGE)
    health = None
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:13010/health', timeout=2) as response:
                health = json.load(response)
            if health.get('ready') is True:
                break
        except Exception:
            pass
        time.sleep(1)
    if not health or health.get('protocol') != 1 or health.get('pushConfigured') is not False:
        raise RuntimeError('Relay health check failed; container preserved for diagnosis')
    rates = pathlib.Path('/etc/nginx/conf.d/lolicode-companion-rate.conf')
    locations = pathlib.Path('/etc/nginx/snippets/lolicode-companion.conf')
    write_new(rates, (source / 'deploy/nginx-http.conf').read_bytes(), 0o644)
    write_new(locations, (source / 'deploy/nginx-locations.conf').read_bytes(), 0o644)
    changed = before if include in before else before.replace(anchor, anchor + b'\n' + include)
    if SITE.read_bytes() != before:
        raise RuntimeError('Concurrent website change before activation; routes not changed')
    receipts = BASE / 'receipts'
    receipts.mkdir(mode=0o700, exist_ok=True)
    write_new(receipts / ('nginx-before-' + args.site_sha256 + '.conf'), before)
    original_stat = SITE.stat()
    temporary = SITE.with_name('lolicode.companion-pending.conf')
    write_new(temporary, changed, original_stat.st_mode & 0o777)
    os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
    os.replace(temporary, SITE)
    try:
        run('nginx', '-t')
    except Exception:
        if SITE.read_bytes() == changed:
            SITE.write_bytes(before)
            SITE.chmod(original_stat.st_mode & 0o777)
        raise
    run('systemctl', 'reload', 'nginx')
    receipt = {'installed': True, 'sourceSha256': args.sha256, 'websiteBefore': args.site_sha256, 'websiteAfter': digest(changed), 'health': health, 'publicWs': 'wss://lolicode.com/companion/ws'}
    write_new(receipts / ('install-' + args.sha256[:16] + '.json'), (json.dumps(receipt, indent=2) + '\n').encode())
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
