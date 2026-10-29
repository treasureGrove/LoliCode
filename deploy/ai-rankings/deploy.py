#!/usr/bin/env python3
"""Install the isolated daily rankings job through an existing SSH alias.

Secrets travel only in SSH stdin. The public feed is seeded once, then the job
owns publication. No other site route, curation service or timer is modified.
"""
import argparse
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

OWNER = 'lolicode-ai-rankings-v1'
MARKER = '.lolicode-ai-rankings-owned'
CODE = Path('/usr/local/lib/lolicode-ai-rankings')
STATE = Path('/var/lib/lolicode-ai-rankings')
CREDENTIALS = Path('/etc/lolicode-ai-rankings')
SITE = Path('/etc/nginx/sites-available/lolicode.conf')
SNIPPET = Path('/etc/nginx/snippets/lolicode-ai-rankings.conf')
SERVICE = 'lolicode-ai-rankings.service'
TIMER = 'lolicode-ai-rankings.timer'
USER = 'lolicode-rankings'
PACKAGE = '@opencode/cli-linux-x64-baseline'
VERSION = '2.0.12'
REGISTRY = 'https://registry.npmjs.org/'
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_PAYLOAD = 4 * 1024 * 1024
HERE = Path(globals().get('__file__', '/usr/local/lib/lolicode-ai-rankings/deploy.py')).resolve().parent
BOOTSTRAP = (
    "import json,sys; raw=sys.stdin.buffer.read(4194305); "
    "assert len(raw)<=4194304,'Deployment payload too large'; "
    "p=json.loads(raw); s=p.pop('program'); "
    "exec(compile(s,'lolicode-ai-rankings-deploy','exec'),"
    "{'__name__':'__remote__','PAYLOAD':p})"
)


class DeployError(RuntimeError):
    """Operator-safe diagnostic that never includes provider responses or keys."""


def require(condition, message):
    if not condition:
        raise DeployError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*argv, timeout=120, check=True):
    try:
        result = subprocess.run(list(argv), capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DeployError('Command unavailable or timed out: ' + str(argv[0])) from error
    if check and result.returncode:
        raise DeployError('Command failed: ' + str(argv[0]))
    return result


def no_symlinks(path):
    for candidate in (path, *path.parents):
        require(not candidate.is_symlink(), 'Refusing symlink at managed path: ' + str(candidate))


def regular_file(path):
    no_symlinks(path)
    require(path.is_file() and stat.S_ISREG(path.stat().st_mode), 'Expected regular managed file: ' + str(path))


def owner_directory(path, uid=0, gid=0, mode=0o755):
    no_symlinks(path)
    if path.exists():
        require(path.is_dir(), 'Managed path is not a directory: ' + str(path))
        marker = path / MARKER
        regular_file(marker)
        require(marker.read_text().strip() == OWNER, 'Unowned directory preserved: ' + str(path))
        require(marker.stat().st_uid == 0, 'Directory marker is not root-owned')
    else:
        path.mkdir(mode=mode)
        atomic_write(path / MARKER, (OWNER + '\n').encode(), 0o644)
    os.chown(path, uid, gid)
    path.chmod(mode)


def atomic_write(path, data, mode, uid=0, gid=0, expected=None):
    no_symlinks(path)
    if path.exists():
        regular_file(path)
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex + '.tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(temporary, flags, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fchown(output.fileno(), uid, gid)
            os.fsync(output.fileno())
        if expected is not None:
            require(path.exists() and path.read_bytes() == expected, 'Concurrent change preserved: ' + str(path))
        no_symlinks(path)
        os.replace(temporary, path)
    finally:
        if temporary.exists() and not temporary.is_symlink():
            temporary.unlink()


def backup_file(path, backup):
    regular_file(path)
    data = path.read_bytes()
    target = backup / (path.name + '-' + digest(data)[:16] + '-' + uuid.uuid4().hex[:8])
    atomic_write(target, data, 0o600)
    return data, path.stat()


def managed_global(path, data, backup):
    require(data.startswith(('# Managed by ' + OWNER + '\n').encode()), 'Missing managed file owner marker')
    if path.exists():
        regular_file(path)
        before = path.read_bytes()
        require(before.startswith(('# Managed by ' + OWNER + '\n').encode()),
                'Unowned service or nginx file preserved: ' + str(path))
        require(path.stat().st_uid == 0, 'Managed system file is not root-owned')
        if before == data:
            return
        backup_file(path, backup)
        atomic_write(path, data, 0o644, expected=before)
    else:
        atomic_write(path, data, 0o644)


def site_with_include(before):
    marker = OWNER.encode()
    begin = b'# BEGIN ' + marker
    end = b'# END ' + marker
    include = b'include /etc/nginx/snippets/lolicode-ai-rankings.conf;'
    anchors = list(re.finditer(rb'(?m)^([ \t]*)include /etc/nginx/snippets/lolicode-companion.conf;[ \t]*$', before))
    require(len(anchors) == 1, 'Expected one companion include in the existing site')
    anchor = anchors[0]
    indent = anchor.group(1)
    block = b'\n' + indent + begin + b'\n' + indent + include + b'\n' + indent + end
    if begin in before or end in before or include in before:
        expected = before[anchor.end():anchor.end() + len(block)]
        require(before.count(begin) == before.count(end) == before.count(include) == 1 and expected == block,
                'Unexpected existing rankings route preserved')
        return before
    return before[:anchor.end()] + block + before[anchor.end():]


def activate_nginx(before, after, snippet, backup):
    regular_file(SITE)
    site_stat = SITE.stat()
    require(SITE.read_bytes() == before, 'Website changed during preparation; preserve state')
    prior_snippet = None
    if SNIPPET.exists():
        regular_file(SNIPPET)
        prior_snippet = (SNIPPET.read_bytes(), SNIPPET.stat())
    backup_file(SITE, backup)
    changed_site = False
    changed_snippet = False
    reload_attempted = False
    try:
        managed_global(SNIPPET, snippet, backup)
        changed_snippet = prior_snippet is None or prior_snippet[0] != snippet
        require(SITE.read_bytes() == before, 'Concurrent website change; routes preserved')
        if before != after:
            atomic_write(SITE, after, stat.S_IMODE(site_stat.st_mode), site_stat.st_uid, site_stat.st_gid, expected=before)
            changed_site = True
        run('nginx', '-t')
        reload_attempted = True
        run('systemctl', 'reload', 'nginx')
    except Exception as error:
        restored = True
        if changed_site:
            if SITE.exists() and SITE.read_bytes() == after:
                atomic_write(SITE, before, stat.S_IMODE(site_stat.st_mode), site_stat.st_uid, site_stat.st_gid, expected=after)
            else:
                restored = False
        if changed_snippet:
            if SNIPPET.exists() and not SNIPPET.is_symlink() and SNIPPET.read_bytes() == snippet:
                if prior_snippet is None:
                    SNIPPET.unlink()
                else:
                    data, info = prior_snippet
                    atomic_write(SNIPPET, data, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, expected=snippet)
            else:
                restored = False
        if restored and reload_attempted:
            try:
                run('nginx', '-t')
                run('systemctl', 'reload', 'nginx')
            except DeployError:
                restored = False
        raise DeployError('nginx activation failed; original configuration restored' if restored
                          else 'nginx activation failed; inspect preserved backups and concurrent changes') from error


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DeployError('Unexpected registry redirect refused')


def registry_download(url, maximum):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname == 'registry.npmjs.org' and
            not parsed.username and not parsed.password and not parsed.port,
            'Runtime download must use the official TLS npm registry')
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers={'User-Agent': 'LoliCode-Rankings-Installer/1'}), timeout=120) as response:
            data = bytearray()
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    return bytes(data)
                data.extend(block)
                require(len(data) <= maximum, 'Registry download exceeded size limit')
    except (OSError, urllib.error.URLError) as error:
        raise DeployError('Official runtime download failed') from error


def verified_binary(metadata, archive):
    require(metadata.get('name') == PACKAGE and metadata.get('version') == VERSION, 'Unexpected runtime package metadata')
    integrity = metadata.get('dist', {}).get('integrity', '')
    hashes = [item[7:] for item in integrity.split() if item.startswith('sha512-')]
    require(len(hashes) == 1, 'Official runtime lacks SHA-512 integrity')
    try:
        expected = base64.b64decode(hashes[0], validate=True)
    except (ValueError, TypeError) as error:
        raise DeployError('Invalid runtime integrity encoding') from error
    require(len(expected) == 64 and hmac.compare_digest(hashlib.sha512(archive).digest(), expected), 'Runtime archive integrity mismatch')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        members = bundle.getmembers()
        require(len(members) <= 128, 'Unexpected runtime archive member count')
        for member in members:
            parts = Path(member.name).parts
            require(not member.name.startswith('/') and '..' not in parts and
                    (member.isfile() or member.isdir()), 'Unsafe runtime archive member')
        matches = [member for member in members if member.name == 'package/bin/opencode']
        require(len(matches) == 1 and matches[0].isfile() and 0 < matches[0].size <= MAX_ARCHIVE,
                'Expected exactly one official package/bin/opencode binary')
        return bundle.extractfile(matches[0]).read()


def ensure_runtime(backup):
    runtime_receipt = CODE / 'runtime.json'
    binary = CODE / 'opencode'
    if runtime_receipt.exists():
        regular_file(runtime_receipt)
        receipt = json.loads(runtime_receipt.read_text())
        require(receipt.get('owner') == OWNER and receipt.get('package') == PACKAGE and receipt.get('version') == VERSION,
                'Unexpected existing runtime receipt preserved')
        regular_file(binary)
        require(binary.stat().st_uid == 0 and digest(binary.read_bytes()) == receipt.get('binarySha256'),
                'Existing runtime differs from its owned receipt')
        return receipt
    require(not binary.exists(), 'Unreceipted existing runtime preserved')
    metadata_url = REGISTRY + urllib.parse.quote(PACKAGE, safe='') + '/' + VERSION
    metadata = json.loads(registry_download(metadata_url, 1024 * 1024))
    require(metadata.get('name') == PACKAGE and metadata.get('version') == VERSION, 'Unexpected registry metadata')
    archive = registry_download(metadata.get('dist', {}).get('tarball', ''), MAX_ARCHIVE)
    data = verified_binary(metadata, archive)
    atomic_write(binary, data, 0o755)
    receipt = {'owner': OWNER, 'package': PACKAGE, 'version': VERSION,
               'metadataUrl': metadata_url, 'tarballUrl': metadata['dist']['tarball'],
               'integrity': metadata['dist']['integrity'], 'archiveSha256': digest(archive),
               'binarySha256': digest(data), 'binaryBytes': len(data)}
    atomic_write(runtime_receipt, (json.dumps(receipt, indent=2) + '\n').encode(), 0o644)
    return receipt


def credential_value(value):
    require(isinstance(value, dict) and set(value).issubset({'apiKey', 'model'}), 'Expected apiKey and optional model in credential JSON')
    key = value.get('apiKey')
    require(isinstance(key, str) and 0 < len(key) <= 4096 and not any(ord(char) < 33 for char in key), 'Credential key is empty or invalid')
    if 'model' in value:
        require(isinstance(value['model'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}', value['model']), 'Invalid credential model')
    return value


def ensure_user():
    import grp
    import pwd
    try:
        group = grp.getgrnam(USER)
    except KeyError:
        run('groupadd', '--system', USER)
        group = grp.getgrnam(USER)
    require(group.gr_gid != 0, 'Service group cannot be root')
    try:
        user = pwd.getpwnam(USER)
    except KeyError:
        run('useradd', '--system', '--gid', USER, '--home-dir', str(STATE / 'private'),
            '--no-create-home', '--shell', '/usr/sbin/nologin', USER)
        user = pwd.getpwnam(USER)
    require(user.pw_uid != 0 and user.pw_gid == group.gr_gid and user.pw_dir == str(STATE / 'private') and
            user.pw_shell in ('/usr/sbin/nologin', '/sbin/nologin'), 'Unexpected existing service account preserved')
    return user.pw_uid, group.gr_gid


def remote_install(payload):
    require(os.geteuid() == 0, 'Installation requires the SSH account to be root')
    require(payload.get('owner') == OWNER, 'Unexpected deployment owner')
    regular_file(SITE)
    before = SITE.read_bytes()
    after = site_with_include(before)
    for path in (CODE, STATE, CREDENTIALS):
        if path.exists():
            no_symlinks(path)
            regular_file(path / MARKER)
            require((path / MARKER).read_text().strip() == OWNER, 'Unowned installation directory preserved')
    for filename in (SERVICE, TIMER):
        path = Path('/etc/systemd/system') / filename
        if path.exists():
            regular_file(path)
            require(path.read_bytes().startswith(('# Managed by ' + OWNER + '\n').encode()), 'Unowned unit preserved')
    if SNIPPET.exists():
        regular_file(SNIPPET)
        require(SNIPPET.read_bytes().startswith(('# Managed by ' + OWNER + '\n').encode()), 'Unowned nginx snippet preserved')
    active = run('systemctl', 'show', SERVICE, '--property=ActiveState', '--value', check=False)
    require(active.stdout.decode('utf8', errors='replace').strip() not in ('active', 'activating', 'reloading', 'deactivating'),
            'Daily rankings job is active; preserve it and retry after completion')
    uid, gid = ensure_user()
    owner_directory(CODE)
    owner_directory(STATE, uid, gid)
    owner_directory(CREDENTIALS, mode=0o700)
    backup = CODE / 'backups'
    if backup.exists():
        no_symlinks(backup)
        require(backup.is_dir() and backup.stat().st_uid == 0, 'Unowned backup directory preserved')
    else:
        backup.mkdir(mode=0o700)
    backup.chmod(0o700)
    for name, mode in [('private', 0o700), ('public', 0o755)]:
        path = STATE / name
        no_symlinks(path)
        if not path.exists():
            path.mkdir(mode=mode)
        require(path.is_dir() and path.stat().st_uid in (0, uid), 'Unexpected state directory owner')
        os.chown(path, uid, gid)
        path.chmod(mode)
    previous_receipt = CODE / 'install-receipt.json'
    previous_hashes = {}
    if previous_receipt.exists():
        regular_file(previous_receipt)
        old = json.loads(previous_receipt.read_text())
        require(old.get('owner') == OWNER, 'Unexpected installation receipt')
        previous_hashes = old.get('files', {})
    files = payload.get('files', {})
    require(set(files) == {'job.py', 'sources.py', 'glm_research.py'}, 'Unexpected deployment code files')
    require(set(payload.get('units', {})) == {SERVICE, TIMER}, 'Unexpected deployment units')
    file_hashes = {}
    for name, encoded in files.items():
        data = base64.b64decode(encoded, validate=True)
        require(len(data) <= 1024 * 1024, 'Deployment code file too large')
        compile(data, str(CODE / name), 'exec')
        path = CODE / name
        if path.exists():
            regular_file(path)
            old = path.read_bytes()
            require(old == data or digest(old) == previous_hashes.get(name), 'Unreceipted code changes preserved: ' + name)
            if old != data:
                backup_file(path, backup)
                atomic_write(path, data, 0o644, expected=old)
        else:
            atomic_write(path, data, 0o644)
        file_hashes[name] = digest(data)
    runtime = ensure_runtime(backup)
    credential = CREDENTIALS / 'glm.json'
    if credential.exists():
        regular_file(credential)
        info = credential.stat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Existing credential permissions are not root-only')
    if payload.get('credential') is not None:
        value = credential_value(payload['credential'])
        if credential.exists():
            old, _ = backup_file(credential, backup)
            atomic_write(credential, (json.dumps(value) + '\n').encode(), 0o600, expected=old)
        else:
            atomic_write(credential, (json.dumps(value) + '\n').encode(), 0o600)
    elif not credential.exists():
        atomic_write(credential, b'{"apiKey":""}\n', 0o600)
    credential_present = bool(json.loads(credential.read_text()).get('apiKey'))
    public = STATE / 'public' / 'latest.json'
    no_symlinks(public)
    if not public.exists():
        seed = base64.b64decode(payload['seed'], validate=True)
        require(len(seed) <= 512 * 1024 and isinstance(json.loads(seed).get('models'), list), 'Invalid bundled seed')
        atomic_write(public, seed, 0o644, uid, gid)
    else:
        regular_file(public)
    for filename in (SERVICE, TIMER):
        managed_global(Path('/etc/systemd/system') / filename,
                       base64.b64decode(payload['units'][filename], validate=True), backup)
    snippet = base64.b64decode(payload['nginx'], validate=True)
    require(snippet.startswith(('# Managed by ' + OWNER + '\n').encode()), 'Invalid nginx owner marker')
    activate_nginx(before, after, snippet, backup)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', TIMER)
    if payload.get('runNow'):
        require(credential_present, 'Job was not started: configure a subscription credential first')
        run('systemctl', 'start', '--no-block', SERVICE)
    receipt = {'owner': OWNER, 'installedAt': int(time.time()), 'files': file_hashes,
               'runtime': runtime, 'siteBeforeSha256': digest(before), 'siteAfterSha256': digest(after),
               'schedule': '09:00 Asia/Singapore daily', 'timerEnabled': True,
               'credentialPresent': credential_present, 'credentialValidated': False,
               'runRequested': bool(payload.get('runNow')), 'publicUrl': 'https://lolicode.com/desktop-assets/ai-rankings.json'}
    if previous_receipt.exists():
        backup_file(previous_receipt, backup)
    atomic_write(previous_receipt, (json.dumps(receipt, indent=2) + '\n').encode(), 0o644)
    return receipt


def ssh_command(host):
    require(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', host)), 'Use an existing SSH alias')
    return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host,
            'python3 -c ' + shlex.quote(BOOTSTRAP)]


def build_payload(credential=None, run_now=False, source=HERE):
    def encoded(path):
        regular_file(path)
        data = path.read_bytes().replace(b'\r\n', b'\n')
        require(len(data) <= 1024 * 1024, 'Local deployment file too large')
        return base64.b64encode(data).decode()
    return {'owner': OWNER, 'program': (source / 'deploy.py').read_text(encoding='utf8'),
            'files': {name: encoded(source / name) for name in ('job.py', 'sources.py', 'glm_research.py')},
            'units': {name: encoded(source / name) for name in (SERVICE, TIMER)},
            'nginx': encoded(source / 'nginx.conf'),
            'seed': encoded(source.parents[1] / 'src/lib/data/ai-rankings.json'),
            'credential': credential, 'runNow': bool(run_now)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--credential-stdin', action='store_true', help='Read subscription apiKey and optional model as JSON from stdin')
    parser.add_argument('--run-now', action='store_true', help='Request one asynchronous verification run after installation')
    args = parser.parse_args(argv)
    command = ssh_command(args.host)
    if args.dry_run:
        print(json.dumps({'dryRun': True, 'host': args.host, 'code': str(CODE), 'state': str(STATE),
                          'schedule': '09:00 Asia/Singapore daily', 'credentialSource': 'stdin' if args.credential_stdin else 'preserve-or-empty-template',
                          'runRequested': args.run_now, 'sshExecuted': False}))
        return 0
    credential = None
    if args.credential_stdin:
        raw = sys.stdin.buffer.read(16 * 1024 + 1)
        require(len(raw) <= 16 * 1024, 'Credential JSON too large')
        try:
            credential = credential_value(json.loads(raw))
        except (ValueError, TypeError) as error:
            raise DeployError('Invalid credential JSON') from error
    payload = json.dumps(build_payload(credential, args.run_now)).encode()
    require(len(payload) <= MAX_PAYLOAD, 'Deployment payload too large')
    try:
        result = subprocess.run(command, input=payload, capture_output=True, timeout=1200)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DeployError('SSH deployment unavailable or timed out; inspect the owned server state before retrying') from error
    if result.returncode != 0:
        message = 'inspect the owned deployment and nginx backups on the host'
        try:
            remote_error = json.loads(result.stderr).get('error', '')
            if isinstance(remote_error, str) and 0 < len(remote_error) <= 500:
                if credential and credential.get('apiKey'):
                    remote_error = remote_error.replace(credential['apiKey'], '[redacted]')
                message = remote_error
        except (ValueError, TypeError, AttributeError):
            pass
        raise DeployError('Remote deployment failed: ' + message)
    try:
        receipt = json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise DeployError('Remote deployment returned no valid receipt') from error
    # Never relay unbounded remote stdout or any credential payload.
    safe = {key: receipt[key] for key in ('owner', 'installedAt', 'schedule', 'timerEnabled', 'credentialPresent',
                                         'credentialValidated', 'runRequested', 'publicUrl', 'siteBeforeSha256', 'siteAfterSha256') if key in receipt}
    print(json.dumps(safe))
    return 0


if __name__ == '__remote__':
    try:
        print(json.dumps(remote_install(PAYLOAD)))
    except Exception as error:
        # The known DeployError messages are constant or managed paths, never credentials.
        print(json.dumps({'error': str(error) if isinstance(error, DeployError) else 'Installation failed; inspect owned server state'}), file=sys.stderr)
        sys.exit(1)
elif __name__ == '__main__':
    try:
        sys.exit(main())
    except DeployError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
