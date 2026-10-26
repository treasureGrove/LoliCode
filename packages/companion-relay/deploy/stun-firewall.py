#!/usr/bin/env python3
"""Operate only this service's table, preserving all unrelated host firewall state."""
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys

BASE = pathlib.Path('/opt/lolicode-companion/stun-only')
OWNER = 'lolicode-companion-stun-only-v1'
TABLE = 'lolicode_stun'


def run(*args, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=5)
    if check and result.returncode:
        raise RuntimeError('Owned STUN firewall operation failed')
    return result


def private(path):
    if path.is_symlink() or path.resolve(strict=True) != path or path.stat().st_uid != 0:
        raise RuntimeError('Unexpected owned STUN path')
    return path


def validate():
    private(BASE)
    if stat.S_IMODE(BASE.stat().st_mode) != 0o700 or private(BASE / 'owner').read_text() != OWNER:
        raise RuntimeError('Unexpected STUN owner')
    manifest = json.loads(private(BASE / 'manifest.json').read_text())
    for name, expected in manifest['files'].items():
        if not name or pathlib.PurePosixPath(name).name != name or name in ('owner', 'manifest.json', 'firewall-active.json'):
            raise RuntimeError('Invalid STUN manifest')
        if hashlib.sha256(private(BASE / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError('STUN source changed; preserve and re-plan')
    return manifest['files']['stun-only.nft']


def receipt(value):
    target = BASE / 'firewall-active.json'
    temporary = BASE / 'firewall-active.pending'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)


def main():
    digest = validate()
    exists = run('/usr/sbin/nft', 'list', 'table', 'inet', TABLE, check=False).returncode == 0
    previous = None
    if (BASE / 'firewall-active.json').exists():
        previous = json.loads(private(BASE / 'firewall-active.json').read_text())
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action == 'start':
        if exists and (not previous or previous.get('sourceSha256') != digest or previous.get('owner') != OWNER or previous.get('active') is not True):
            raise RuntimeError('Existing unowned STUN table preserved')
        if not exists:
            run('/usr/sbin/nft', '--check', '--file', str(BASE / 'stun-only.nft'))
            run('/usr/sbin/nft', '--file', str(BASE / 'stun-only.nft'))
        receipt({'owner': OWNER, 'sourceSha256': digest, 'active': True})
        print('{"stunFirewall":"active"}')
    elif action == 'stop':
        current = run('/usr/bin/docker', 'inspect', '--format', '{{.State.Running}}', 'lolicode-stun', check=False)
        if current.returncode == 0 and current.stdout.strip() == 'true':
            raise RuntimeError('STUN container still running; firewall retained')
        if exists:
            if not previous or previous.get('sourceSha256') != digest or previous.get('owner') != OWNER or previous.get('active') is not True:
                raise RuntimeError('Unowned STUN table preserved')
            run('/usr/sbin/nft', 'delete', 'table', 'inet', TABLE)
        receipt({'owner': OWNER, 'sourceSha256': digest, 'active': False})
        print('{"stunFirewall":"inactive"}')
    elif action == 'status':
        value = run('/usr/sbin/nft', '--json', 'list', 'table', 'inet', TABLE)
        counters = []
        for item in json.loads(value.stdout).get('nftables', []):
            rule = item.get('rule', {})
            for expression in rule.get('expr', []):
                if 'counter' in expression:
                    counters.append({'chain': rule.get('chain'), **expression['counter']})
        # Never emit dynamic address sets or packet contents.
        print(json.dumps({'stunFirewall': 'active', 'counters': counters}))
    else:
        raise RuntimeError('Expected start, stop or status')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"stunFirewall":"error","message":"Owned firewall preconditions failed; state preserved."}')
        raise SystemExit(1) from None
