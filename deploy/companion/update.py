#!/usr/bin/env python3
"""CAS-guarded control-service update. Default is read-only; --activate switches.

Never reads container environment or prints state/provider responses. A private,
atomic state+config bundle and the stopped old container remain for rollback.
STUN and provider firewall changes are deliberately a separate reviewed action.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

BASE = pathlib.Path('/opt/lolicode-companion')
SITE = pathlib.Path('/etc/nginx/sites-available/lolicode.conf')
RATES = pathlib.Path('/etc/nginx/conf.d/lolicode-companion-rate.conf')
LOCATIONS = pathlib.Path('/etc/nginx/snippets/lolicode-companion.conf')
NAME = 'lolicode-companion'
OWNER = 'lolicode-android-companion-v1'
HASH = re.compile(r'^[a-f0-9]{64}$')
INSPECT = ('{"imageId":{{json .Image}},"image":{{json .Config.Image}},'
           '"owner":{{json (index .Config.Labels "art.treasuregrove.owner")}},'
           '"running":{{json .State.Running}},"network":{{json .HostConfig.NetworkMode}},'
           '"readOnly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}}}')


class UpdateError(Exception):
    pass


class ProbeError(UpdateError):
    def __init__(self, details):
        super().__init__('Public control readiness check failed')
        self.details = details


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fsync_directory(path):
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def exclusive(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        # Preserve partial artifacts for diagnosis; never replace another file.
        raise


def ordinary(path, limit=32 * 1024 * 1024):
    if path.is_symlink() or path.resolve(strict=True) != path or not path.is_file():
        raise UpdateError('Unexpected file layout; preserve and re-plan')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise UpdateError('Unexpected non-regular file')
        data = source.read(limit + 1)
        if len(data) > limit:
            raise UpdateError('File exceeds reviewed size bound')
        return data


def atomic_replace(path, data, metadata, expected=None):
    if path.is_symlink() or path.resolve(strict=True) != path:
        raise UpdateError('Unexpected config target; preserve and re-plan')
    temporary = path.with_name(path.name + '.companion-' + secrets.token_hex(6))
    exclusive(temporary, data, stat.S_IMODE(metadata.st_mode))
    if os.name != 'nt':
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
    if expected is not None and ordinary(path) != expected:
        raise UpdateError('Concurrent config change preserved')
    os.replace(temporary, path)
    fsync_directory(path.parent)


def archive_files(path, expected):
    blob = ordinary(path, 5 * 1024 * 1024)
    if not HASH.fullmatch(expected) or digest(blob) != expected:
        raise UpdateError('Source archive digest/size mismatch')
    files = {}
    total = 0
    # Parse exactly the bytes whose digest was checked, not a second open that
    # could race with another upload of the same archive path.
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) > 128:
            raise UpdateError('Too many source archive members')
        for member in members:
            name = member.name.rstrip('/')
            parts = pathlib.PurePosixPath(name).parts
            if not parts or '..' in parts or name.startswith('/') or pathlib.PurePosixPath(name).as_posix() != name or not re.fullmatch(r'[A-Za-z0-9._/-]+', name):
                raise UpdateError('Unsafe source archive path')
            if not (member.isdir() or member.isfile()) or member.size < 0:
                raise UpdateError('Source archive links/special files refused')
            if member.isdir():
                continue
            allowed = (parts[0] == 'src' and name.endswith('.mjs')) or (parts[0] == 'deploy' and pathlib.PurePosixPath(name).suffix in ('.conf', '.md', '.nft', '.yml', '.py', '.service')) or name in ('Dockerfile', 'package.json', 'package-lock.json')
            if not allowed or name in files:
                raise UpdateError('Unapproved or duplicate source member')
            total += member.size
            if total > 5 * 1024 * 1024:
                raise UpdateError('Expanded source exceeds limit')
            files[name] = bundle.extractfile(member).read()
    required = ('Dockerfile', 'package.json', 'package-lock.json', 'src/server.mjs', 'src/main.mjs',
                'src/accounts.mjs', 'src/account-http.mjs', 'src/account-validation.mjs', 'src/forum.mjs',
                'src/store.mjs', 'deploy/nginx-http.conf', 'deploy/nginx-locations.conf')
    if any(name not in files for name in required):
        raise UpdateError('Incomplete account-v2 source archive')
    if any(str(parent) in files for name in files for parent in pathlib.PurePosixPath(name).parents):
        raise UpdateError('Conflicting source archive paths')
    return files


@contextlib.contextmanager
def activation_lock():
    if os.name != 'posix':
        raise UpdateError('Activation requires the reviewed Linux host')
    import fcntl
    fd = os.open(BASE / 'update.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise UpdateError('Unexpected update lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def probe(url, expected_status=200):
    # URLs are fixed constants at call sites, with no credentials or cookies.
    try:
        response = urllib.request.build_opener(NoRedirect).open(url, timeout=3)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(4097)
        media = response.headers.get('content-type', '').split(';')[0].strip().lower()
        details = {'endpoint': 'devices' if url.endswith('/v2/devices') else 'health' if url.endswith('/health') else 'other',
                   'expectedStatus': expected_status, 'actualStatus': response.status,
                   'contentType': media if media in ('application/json', 'text/html', 'text/plain') else 'other', 'errorCode': None}
        if len(body) > 4096:
            raise ProbeError({**details, 'failure': 'response_size'})
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            raise ProbeError({**details, 'failure': 'invalid_json'}) from None
        error = value.get('error') if isinstance(value, dict) else None
        if isinstance(error, dict) and error.get('code') in ('unauthorized', 'forbidden', 'not_found', 'bad_request', 'rate_limited', 'capacity', 'internal_error'):
            details['errorCode'] = error['code']
        if response.status != expected_status:
            raise ProbeError({**details, 'failure': 'status_mismatch'})
        return value


def command(*args, check=True, timeout=600):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise UpdateError('Operation failed: ' + args[0] + ' ' + (args[1] if len(args) > 1 else ''))
    return result


class Update:
    def __init__(self, args, run=command, check_endpoint=probe):
        self.args, self.run, self.probe = args, run, check_endpoint
        self.phase = 'preflight'
        self.original = {}
        self.stop_attempted = self.old_renamed = self.new_attempted = False
        self.backup = None
        self.first_mismatch = None
        self.public_attempts = 0

    def inspect(self, name=NAME, required=True):
        result = self.run('docker', 'inspect', '--format', INSPECT, name, check=False)
        if result.returncode:
            if required:
                raise UpdateError('Expected owned container is absent')
            return None
        return json.loads(result.stdout)

    def validate_baseline(self):
        for path, (data, _) in self.original.items():
            if ordinary(path) != data:
                raise UpdateError('Concurrent nginx change; preserve and re-plan')
        current = self.inspect()
        if current['imageId'] != self.args.expected_image_id or current['owner'] != OWNER or not current['running']:
            raise UpdateError('Container changed; preserve and re-plan')

    def plan(self):
        for value in (self.args.sha256, self.args.site_sha256, self.args.rates_sha256, self.args.locations_sha256):
            if not HASH.fullmatch(value):
                raise UpdateError('Invalid pinned digest')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', self.args.expected_image_id):
            raise UpdateError('Invalid previous image ID')
        if BASE.is_symlink() or BASE.resolve(strict=True) != BASE or ordinary(BASE / 'owner') != OWNER.encode():
            raise UpdateError('Unowned companion directory')
        self.files = archive_files(pathlib.Path(self.args.archive).resolve(strict=True), self.args.sha256)
        for path, expected in ((SITE, self.args.site_sha256), (RATES, self.args.rates_sha256), (LOCATIONS, self.args.locations_sha256)):
            data = ordinary(path)
            if digest(data) != expected:
                raise UpdateError('Nginx baseline changed; preserve and re-plan')
            self.original[path] = (data, path.stat())
        if b'include /etc/nginx/snippets/lolicode-companion.conf;' not in self.original[SITE][0]:
            raise UpdateError('Expected existing companion route include absent')
        current = self.inspect()
        mount = current.get('mounts', [])
        if current['owner'] != OWNER or current['imageId'] != self.args.expected_image_id or not current['running'] or current['network'] != 'host' or not current['readOnly'] or len(mount) != 1 or mount[0].get('Type') != 'bind' or mount[0].get('Source') != str(BASE / 'state') or mount[0].get('Destination') != '/var/lib/lolicode-companion' or not mount[0].get('RW'):
            raise UpdateError('Unexpected owned container layout')
        state = BASE / 'state'
        metadata = state.stat()
        if state.is_symlink() or state.resolve(strict=True) != state or not state.is_dir() or metadata.st_uid != 1000 or metadata.st_gid != 1000 or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise UpdateError('Unexpected private state layout')
        old_health = self.probe('http://127.0.0.1:13010/health')
        if old_health.get('ready') is not True or old_health.get('pushConfigured') is not False:
            raise UpdateError('Unexpected previous service health/configuration')
        self.image = 'lolicode-companion:account-v2-' + self.args.sha256[:16]
        return {'plan': True, 'sourceSha256': self.args.sha256, 'newImage': self.image,
                'previousImageId': current['imageId'], 'owner': OWNER, 'statePath': str(state),
                'websiteUnchanged': True, 'publicHttp': 'https://lolicode.com/companion/v2',
                'transportPolicy': 'directOnly', 'stunActivation': False,
                'configBefore': {str(path): digest(data) for path, (data, _) in self.original.items()}}

    def stage_source(self):
        source = BASE / ('source-account-v2-' + self.args.sha256[:16])
        if source.exists():
            if source.is_symlink() or source.resolve() != source:
                raise UpdateError('Unsafe existing source path')
            entries = list(source.rglob('*'))
            if any(path.is_symlink() or not (path.is_file() or path.is_dir()) for path in entries):
                raise UpdateError('Unsafe existing source member')
            existing = {path.relative_to(source).as_posix(): ordinary(path) for path in entries if path.is_file()}
            if existing != self.files:
                raise UpdateError('Different existing source preserved')
        else:
            source.mkdir(mode=0o700)
            for name, data in self.files.items():
                target = source.joinpath(*pathlib.PurePosixPath(name).parts)
                target.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
                exclusive(target, data, 0o644)
        return source

    def backup_bundle(self):
        root = BASE / 'backups'
        root.mkdir(mode=0o700, exist_ok=True)
        if root.is_symlink() or root.resolve() != root or stat.S_IMODE(root.stat().st_mode) != 0o700:
            raise UpdateError('Unsafe backup directory')
        self.identifier = self.args.sha256[:8] + '-' + str(int(time.time())) + '-' + secrets.token_hex(4)
        pending = root / ('.pending-' + self.identifier)
        pending.mkdir(mode=0o700)
        (pending / 'state').mkdir(mode=0o700)
        (pending / 'config').mkdir(mode=0o700)
        hashes = {}
        entries = list((BASE / 'state').iterdir())
        if len(entries) > 256:
            raise UpdateError('Unexpected state file count')
        total = 0
        for path in entries:
            if path.name not in ('rooms.json', 'push-state.key') and not re.fullmatch(r'rooms\.json\.[a-f0-9]{16}\.tmp', path.name):
                raise UpdateError('Unexpected state member; preserved')
            before = path.stat()
            if path.is_symlink() or not path.is_file() or before.st_mode & 0o077 or before.st_uid != 1000 or before.st_gid != 1000:
                raise UpdateError('Unsafe state member; preserved')
            total += before.st_size
            if total > 32 * 1024 * 1024:
                raise UpdateError('State backup exceeds bound')
            data = ordinary(path)
            after = path.stat()
            version = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if version(after) != version(before):
                raise UpdateError('State changed while stopped; preserve and re-plan')
            exclusive(pending / 'state' / path.name, data)
            hashes[path.name] = digest(data)
        if not (pending / 'state' / 'push-state.key').exists():
            raise UpdateError('Missing state key; preserved')
        for path, (data, _) in self.original.items():
            exclusive(pending / 'config' / path.name, data)
        exclusive(pending / 'manifest.json', json.dumps({'sourceSha256': self.args.sha256,
            'previousImageId': self.args.expected_image_id, 'stateHashes': hashes,
            'configHashes': {str(path): digest(data) for path, (data, _) in self.original.items()}}, sort_keys=True).encode())
        for directory in (pending / 'state', pending / 'config', pending):
            fsync_directory(directory)
        backup = root / ('account-v2-' + self.identifier)
        os.rename(pending, backup)
        fsync_directory(root)
        return backup

    def validate_new_health(self):
        for _ in range(30):
            try:
                value = self.probe('http://127.0.0.1:13010/health')
                if value.get('ready') is True and value.get('protocol') == 1 and value.get('accountProtocol') == 2 and value.get('transportPolicy') == 'directOnly' and value.get('legacyDataRelay') is False and value.get('pushConfigured') is False:
                    return value
            except Exception:
                pass
            time.sleep(0.5)
        raise UpdateError('New control-service health failed')

    def public_smoke(self, health):
        # Reload signals the master; it does not wait for the new worker to
        # accept requests. Existing health and newly added v2 routes must both
        # converge. These retries are GET-only and never replay mutations.
        last = None
        for attempt in range(1, 11):
            self.public_attempts = attempt
            try:
                public = self.probe('https://lolicode.com/companion/health')
                if public != health:
                    raise ProbeError({'endpoint': 'health', 'expectedStatus': 200, 'actualStatus': 200,
                                      'failure': 'health_schema_mismatch'})
                value = self.probe('https://lolicode.com/companion/v2/devices', 401)
                if value != {'error': {'code': 'unauthorized', 'message': 'Authentication required.'}}:
                    raise ProbeError({'endpoint': 'devices', 'expectedStatus': 401, 'actualStatus': 401,
                                      'failure': 'error_schema_mismatch'})
                return
            except Exception as error:
                last = error.details if isinstance(error, ProbeError) else {'endpoint': 'public_control', 'failure': 'network_or_transport'}
                if self.first_mismatch is None:
                    self.first_mismatch = last
                if attempt < 10:
                    time.sleep(0.5)
        raise ProbeError(last)

    def rollback(self):
        current = self.inspect(required=False)
        matches_old = lambda value: value and value.get('owner') == OWNER and value.get('imageId') == self.args.expected_image_id
        old_name = NAME
        if not matches_old(current):
            old_name = NAME + '-before-' + self.identifier if hasattr(self, 'identifier') else None
            if not old_name or not matches_old(self.inspect(old_name, required=False)):
                raise UpdateError('Owned baseline container unavailable; manual recovery required')
        if self.new_attempted:
            if current:
                if current['owner'] != OWNER or current['image'] != self.image:
                    raise UpdateError('Unexpected replacement container; manual rollback required')
                self.run('docker', 'stop', '--time', '10', NAME)
                self.run('docker', 'rename', NAME, NAME + '-failed-' + self.identifier)
            # Preserve any newly written state; an old v1 binary must never read it.
            os.rename(BASE / 'state', self.backup / 'failed-state')
            replacement = BASE / ('state-rollback-' + self.identifier)
            replacement.mkdir(mode=0o700)
            if os.name != 'nt':
                os.chown(replacement, 1000, 1000)
            for path in (self.backup / 'state').iterdir():
                target = replacement / path.name
                exclusive(target, ordinary(path))
                if os.name != 'nt':
                    os.chown(target, 1000, 1000)
            fsync_directory(replacement)
            os.rename(replacement, BASE / 'state')
            fsync_directory(BASE)
        conflicts = False
        for path, (before, metadata) in self.original.items():
            current = ordinary(path)
            after = self.files['deploy/nginx-http.conf'] if path == RATES else self.files['deploy/nginx-locations.conf'] if path == LOCATIONS else before
            if current not in (before, after):
                conflicts = True
                continue
            if current != before:
                atomic_replace(path, before, metadata, expected=current)
        if old_name != NAME:
            self.run('docker', 'rename', old_name, NAME)
        restored = self.inspect()
        if not matches_old(restored):
            raise UpdateError('Baseline changed during rollback; preserved')
        if not restored['running']:
            self.run('docker', 'start', NAME)
        if conflicts:
            raise UpdateError('Prior container restored; concurrent nginx edit preserved')
        self.run('nginx', '-t')
        self.run('systemctl', 'reload', 'nginx')

    def activate(self):
        self.phase = 'build'
        source = self.stage_source()
        existing = self.run('docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', self.image, check=False)
        if existing.returncode == 0:
            labels = json.loads(existing.stdout) or {}
            if labels.get('art.treasuregrove.owner') != OWNER or labels.get('art.treasuregrove.source-sha256') != self.args.sha256:
                raise UpdateError('Unowned image tag preserved')
        self.run('docker', 'build', '--pull', '--label', 'art.treasuregrove.owner=' + OWNER,
                 '--label', 'art.treasuregrove.source-sha256=' + self.args.sha256, '-t', self.image, str(source))
        self.validate_baseline()
        self.phase = 'backup'
        try:
            # A stop can take effect even if its CLI later times out/errors.
            # From the first attempt onward, inspect the owned baseline and
            # recover rather than assuming a failed command made no changes.
            self.stop_attempted = True
            self.run('docker', 'stop', '--time', '10', NAME)
            self.backup = self.backup_bundle()
            self.validate_config_cas()
            self.run('docker', 'rename', NAME, NAME + '-before-' + self.identifier)
            self.old_renamed = True
            self.phase = 'start'
            self.new_attempted = True
            self.run('docker', 'run', '-d', '--name', NAME, '--label', 'art.treasuregrove.owner=' + OWNER,
                     '--label', 'art.treasuregrove.source-sha256=' + self.args.sha256, '--restart', 'unless-stopped',
                     '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                     '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
                     '--mount', 'type=bind,src=' + str(BASE / 'state') + ',dst=/var/lib/lolicode-companion', self.image)
            health = self.validate_new_health()
            self.phase = 'nginx'
            self.validate_config_cas()
            for path, name in ((RATES, 'nginx-http.conf'), (LOCATIONS, 'nginx-locations.conf')):
                atomic_replace(path, self.files['deploy/' + name], self.original[path][1], expected=self.original[path][0])
            self.run('nginx', '-t')
            self.run('systemctl', 'reload', 'nginx')
            self.phase = 'public-smoke'
            self.public_smoke(health)
            receipt = {'updated': True, 'sourceSha256': self.args.sha256, 'image': self.image,
                       'previousImageId': self.args.expected_image_id, 'backup': str(self.backup), 'health': health,
                       'websiteSha256': digest(ordinary(SITE)), 'transportPolicy': 'directOnly', 'stunActivated': False,
                       'publicProbeAttempts': self.public_attempts, 'firstMismatch': self.first_mismatch}
            exclusive(self.backup / 'success.json', json.dumps(receipt, sort_keys=True).encode())
            self.phase = 'complete'
            return receipt
        except BaseException as error:
            self.diagnostic = error.details if isinstance(error, ProbeError) else None
            if self.backup:
                try:
                    exclusive(self.backup / 'failure.json', json.dumps({'phase': self.phase,
                        'sourceSha256': self.args.sha256, 'diagnostic': self.diagnostic,
                        'firstMismatch': self.first_mismatch, 'publicProbeAttempts': self.public_attempts}).encode())
                except Exception:
                    pass
            try:
                self.rollback()
                self.phase += '-rolled-back'
            except BaseException:
                self.phase += '-rollback-needs-attention'
            raise UpdateError('Update failed; prior/failed artifacts preserved; phase=' + self.phase) from None

    def validate_config_cas(self):
        for path, (before, _) in self.original.items():
            if ordinary(path) != before:
                raise UpdateError('Concurrent nginx change; preserve and re-plan')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('archive', 'sha256', 'site-sha256', 'rates-sha256', 'locations-sha256', 'expected-image-id'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--activate', action='store_true')
    args = parser.parse_args()
    update = Update(args)
    try:
        plan = update.plan()
        if args.activate:
            with activation_lock():
                update.validate_baseline()
                result = update.activate()
        else:
            result = plan
        print(json.dumps(result, sort_keys=True))
    except Exception:
        print(json.dumps({'updated': False, 'phase': update.phase, 'diagnostic': getattr(update, 'diagnostic', None),
                          'firstMismatch': update.first_mismatch, 'publicProbeAttempts': update.public_attempts,
                          'error': 'Preconditions or update failed; preserve artifacts and inspect the reviewed plan.'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
