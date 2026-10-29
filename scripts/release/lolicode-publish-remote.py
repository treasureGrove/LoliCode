#!/usr/bin/env python3
"""Owned LoliCode namespace only. Invoked through SSH stdin; no credentials."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid

ROOT = Path('/www/wwwroot/tools.treasuregrove.art/lolicode')
SITE_NAMES = {'index.html', 'assets/site.css', 'assets/downloads.js', 'assets/logo.svg', 'assets/maid.png', 'assets/workbench.jpg', 'assets/discovery-v1.json'}


def version(value):
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value)
    if not match:
        raise ValueError('Invalid published SemVer.')
    pre = match[4].split('.') if match[4] else []
    if any(p.isdigit() and len(p) > 1 and p.startswith('0') for p in pre):
        raise ValueError('Invalid published SemVer prerelease.')
    return [int(match[i]) for i in (1, 2, 3)], pre


def compare(a, b):
    ac, ap = version(a)
    bc, bp = version(b)
    if ac != bc:
        return 1 if ac > bc else -1
    if not ap or not bp:
        return int(not ap) - int(not bp)
    for x, y in zip(ap, bp):
        if x == y:
            continue
        if x.isdigit() and y.isdigit():
            return 1 if int(x) > int(y) else -1
        if x.isdigit() != y.isdigit():
            return -1 if x.isdigit() else 1
        return 1 if x > y else -1
    return (len(ap) > len(bp)) - (len(ap) < len(bp))


def no_symlink(path):
    if path.is_symlink():
        raise ValueError('Refusing symlink inside the publishing namespace.')
    return path


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.next-' + str(uuid.uuid4()))
    with temporary.open('x', encoding='utf8') as output:
        json.dump(value, output, sort_keys=True)
    os.replace(temporary, path)


def checksum(path):
    no_symlink(path)
    if not path.is_file():
        raise ValueError('Expected an uploaded regular file.')
    sha = hashlib.sha256()
    size = 0
    with path.open('rb') as data:
        while True:
            block = data.read(1024 * 1024)
            if not block:
                break
            sha.update(block)
            size += len(block)
    return size, sha.hexdigest()


def main(phase, spec):
    stage_id = spec['stageId']
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', stage_id):
        raise ValueError('Invalid staging ID.')
    release_version = spec['version']
    public_version = spec.get('productVersion', release_version)
    build_core, build_pre = version(release_version)
    expected_public = (f'{build_core[0]-3}.{build_core[1]-1}.{build_core[2]}'
                       if build_core[0] >= 4 and build_core[1] >= 1 else release_version)
    if public_version != expected_public or version(public_version)[1]:
        raise ValueError('Product/build version mismatch.')
    if version(release_version)[1]:
        raise ValueError('Stable latest.json cannot publish a prerelease')
    if spec['namespace'] != str(ROOT):
        raise ValueError('Publishing outside LoliCode is forbidden.')
    no_symlink(ROOT)
    for group in ('releases', 'updates'):
        no_symlink(ROOT / group)
    lock = no_symlink(ROOT / '.publish-lock')
    owner = lock / 'owner'
    stage = no_symlink(ROOT / ('.publish-stage-' + stage_id))
    destination = no_symlink(ROOT / 'releases' / public_version)
    latest = no_symlink(ROOT / 'updates' / 'latest.json')
    content = {key: value for key, value in spec.items() if key != 'resume'}
    plan_hash = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    expected_release = {f'LoliCode-{public_version}-Windows-x64-Setup.exe',
                        f'LoliCode-{public_version}-Windows-x64-Setup.exe.sig',
                        'LoliCode-Portable.zip', 'latest.json', 'release-manifest.json', 'upload-plan.json'}
    seen = set()
    for item in spec['files']:
        identity = (item['role'], item['name'])
        if identity in seen or item['role'] not in ('release', 'site'):
            raise ValueError('Unexpected duplicate uploaded file.')
        seen.add(identity)
        allowed = expected_release if item['role'] == 'release' else SITE_NAMES
        preview = item['role'] == 'site' and re.fullmatch(r'assets/rankings/[a-z0-9-]+-[a-f0-9]{12}\.(?:png|jpg)', item['name'])
        if (item['name'] not in allowed and not preview) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']) or not isinstance(item['bytes'], int) or item['bytes'] <= 0:
            raise ValueError('Unsafe uploaded path or checksum.')

    def require_owner():
        no_symlink(owner)
        if not owner.is_file() or owner.read_text() != stage_id:
            raise ValueError('Publication lock is not owned by this operation.')

    def no_downgrade():
        if latest.exists():
            published = json.loads(latest.read_text(encoding='utf8'))
            if compare(published['version'], release_version) >= 0:
                raise ValueError('Published latest version is equal or newer; refusing rollback/overwrite.')

    def verify_files(release_root):
        for item in spec['files']:
            base = release_root if item['role'] == 'release' else stage / 'site'
            no_symlink(base)
            for parent in Path(item['name']).parents:
                no_symlink(base / parent)
            if checksum(base / item['name']) != (item['bytes'], item['sha256']):
                raise ValueError('Remote uploaded size/SHA256 mismatch.')

    if phase == 'abort':
        if lock.exists():
            require_owner()
            owner.unlink()
            lock.rmdir()  # Only the owned lock, never recursive cleanup.
        return {'ok': True, 'stagingRetained': True}

    if phase == 'begin':
        ROOT.mkdir(parents=True, exist_ok=True)
        (ROOT / 'releases').mkdir(exist_ok=True)
        (ROOT / 'updates').mkdir(exist_ok=True)
        if lock.exists():
            if not spec.get('resume'):
                raise ValueError('Another publication holds the lock; manual recovery may be required.')
            require_owner()
        else:
            lock.mkdir(mode=0o700)
            with owner.open('x') as output:
                output.write(stage_id)
        no_downgrade()
        if spec.get('resume'):
            stored = json.loads((stage / 'state.json').read_text())
            if stored['planHash'] != plan_hash:
                raise ValueError('Resume stage belongs to different release bytes or website files.')
            if stored['artifactsReady']:
                verify_files(destination)
                return {'ok': True, 'artifactsReady': True, 'resume': True}
            if destination.exists():
                # Recover an interrupted rename whose state write did not run.
                # This verifies every byte; it never overwrites the directory.
                verify_files(destination)
                atomic_json(stage / 'state.json', {'planHash': plan_hash, 'artifactsReady': True})
                return {'ok': True, 'artifactsReady': True, 'resume': True}
        else:
            if destination.exists():
                raise ValueError('Immutable release version already exists.')
            stage.mkdir(mode=0o700)
            (stage / 'release').mkdir(mode=0o755)
            (stage / 'site' / 'assets').mkdir(parents=True)
            if any(item['role'] == 'site' and item['name'].startswith('assets/rankings/') for item in spec['files']):
                (stage / 'site' / 'assets' / 'rankings').mkdir()
            atomic_json(stage / 'state.json', {'planHash': plan_hash, 'artifactsReady': False})
        return {'ok': True, 'artifactsReady': False, 'resume': bool(spec.get('resume'))}

    require_owner()
    state = json.loads((stage / 'state.json').read_text())
    if state['planHash'] != plan_hash:
        raise ValueError('Publication stage does not match the supplied file plan.')
    if phase == 'commit-artifacts':
        no_downgrade()
        if destination.exists():
            raise ValueError('Immutable version exists; never overwrite it.')
        verify_files(stage / 'release')
        for item in spec['files']:
            if item['role'] == 'release':
                os.chmod(stage / 'release' / item['name'], 0o644)
        os.rename(stage / 'release', destination)
        atomic_json(stage / 'state.json', {'planHash': plan_hash, 'artifactsReady': True})
        return {'ok': True, 'artifactsReady': True, 'remoteHashesAndBytesVerified': True}
    if phase != 'finalize' or not state['artifactsReady']:
        raise ValueError('Invalid publication phase.')
    no_downgrade()
    verify_files(destination)
    for item in spec['files']:
        if item['role'] != 'site':
            continue
        target = ROOT / item['name']
        no_symlink(target)
        no_symlink(target.parent).mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.next-' + stage_id + '-' + str(uuid.uuid4()))
        with temporary.open('xb') as output, (stage / 'site' / item['name']).open('rb') as source:
            shutil.copyfileobj(source, output)
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    # This is the only write of the mutable updater pointer, after every check.
    temporary = latest.with_name('.latest-' + stage_id + '-' + str(uuid.uuid4()) + '.json')
    with temporary.open('xb') as output, (destination / 'latest.json').open('rb') as source:
        shutil.copyfileobj(source, output)
    os.chmod(temporary, 0o644)
    os.replace(temporary, latest)
    atomic_json(stage / 'state.json', {'planHash': plan_hash, 'artifactsReady': True, 'published': True})
    owner.unlink()
    lock.rmdir()
    return {'ok': True, 'version': release_version, 'latestPublishedLast': True, 'stagingRetained': True}


if __name__ == '__main__':
    try:
        supplied = json.loads(base64.b64decode(sys.argv[2], validate=True).decode('utf8'))
        print(json.dumps(main(sys.argv[1], supplied)))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
