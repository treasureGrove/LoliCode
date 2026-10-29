#!/usr/bin/env python3
"""Publish the independently verified Android alpha bundle, never desktop feeds.

Default is a read-only plan. Run --activate only on the lolicode host after
reviewing that plan. The source tar is produced from the directory prepared by
scripts/release/lolicode-android-download.mjs. No Firebase credentials are involved.
"""
import argparse
import contextlib
import datetime
import hashlib
import html.parser
import io
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile
import uuid
import xml.etree.ElementTree as xml


PUBLIC = pathlib.Path('/var/www/lolicode-companion-public')
SNIPPET = pathlib.Path('/etc/nginx/snippets/lolicode-companion.conf')
OWNER = b'lolicode-companion-android-public-v1\n'
MARKER = 'lolicode-companion-android-download-v1'
VERSION = re.compile(r'0\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})-alpha\.(?:0|[1-9][0-9]{0,8})\Z')
SHA256 = re.compile(r'[a-fA-F0-9]{64}\Z')
MAX_APK = 100 * 1024 * 1024
MAX_DESKTOP = 250 * 1024 * 1024
MAX_ASSET = 2 * 1024 * 1024
MAX_TOTAL = MAX_APK + MAX_DESKTOP + 10 * 1024 * 1024
SECRETS = re.compile(
    rb'-----BEGIN [A-Z ]*PRIVATE KEY-----|'
    rb'["\'](?:private_key|privateKey|phoneToken|desktopToken|client_secret|access_token|refresh_token)["\']\s*:|'
    rb'LOLICODE_ANDROID_STORE_PASSWORD|LOLICODE_COMPANION_FCM_SERVICE_ACCOUNT', re.IGNORECASE)

# This suffix is deliberately constant across alpha releases. Version selection
# happens only through the separately managed, atomic mobile symlink.
LOCATIONS = ('''

# BEGIN ''' + MARKER + '''
location = /mobile {
    add_header Cache-Control "no-store" always;
    return 302 /mobile/;
}

location ^~ /mobile/ {
    alias /var/www/lolicode-companion-public/mobile/;
    index index.html;
    autoindex off;
    types {
        text/html html;
        image/png png;
        image/svg+xml svg;
        application/json json;
        application/vnd.android.package-archive apk;
        application/zip zip;
    }
    default_type application/octet-stream;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff" always;
}

location ^~ /downloads/android/ {
    alias /var/www/lolicode-companion-public/releases/;
    autoindex off;
    types {
        text/html html;
        image/png png;
        image/svg+xml svg;
        application/json json;
        application/vnd.android.package-archive apk;
        application/zip zip;
    }
    default_type application/octet-stream;
    set $lolicode_android_cache "no-store";
    if ($uri ~ "\\.(?:apk|zip)$") {
        set $lolicode_android_cache "public, max-age=31536000, immutable";
    }
    add_header Cache-Control $lolicode_android_cache;
    add_header X-Content-Type-Options "nosniff" always;
}
# END ''' + MARKER + '\n').encode('utf-8')


class PublishError(RuntimeError):
    """Safe, credential-free diagnostic intended for the operator."""


def require(condition, message):
    if not condition:
        raise PublishError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def artifact_limit(name):
    if name.endswith('.apk'):
        return MAX_APK
    if name.endswith('.zip'):
        return MAX_DESKTOP
    return MAX_ASSET


def lstat(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def regular_bytes(path, maximum):
    """No symlink following, including a dangling symlink at the final path."""
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum,
                'Expected a bounded regular file: ' + str(path))
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            data = source.read(maximum + 1)
        require(len(data) <= maximum, 'File grew beyond its bound: ' + str(path))
        return data, info
    finally:
        os.close(descriptor)


def owned_directory(path):
    info = lstat(path)
    require(info is not None and stat.S_ISDIR(info.st_mode), 'Directory is missing or redirected: ' + str(path))
    require(info.st_uid == 0 and not info.st_mode & 0o022, 'Directory is not private to the root publisher: ' + str(path))


def validate_root():
    if lstat(PUBLIC) is None:
        return False
    owned_directory(PUBLIC)
    marker, info = regular_bytes(PUBLIC / 'owner', 1024)
    require(info.st_uid == 0 and not info.st_mode & 0o022 and marker == OWNER, 'Existing public directory has no matching owner marker')
    return True


def unique_json(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'Duplicate JSON field')
        value[key] = item
    return value


class LandingParser(html.parser.HTMLParser):
    def __init__(self, allowed_urls):
        super().__init__(convert_charrefs=True)
        self.allowed_urls = allowed_urls

    def handle_starttag(self, tag, attrs):
        require(tag.lower() not in {'script', 'iframe', 'object', 'embed', 'form', 'base'}, 'Active content is not allowed in the static landing')
        for name, value in attrs:
            require(not name.lower().startswith('on'), 'Event handlers are not allowed in the static landing')
            if name.lower() in {'href', 'src', 'action'}:
                require(value in self.allowed_urls, 'Unapproved URL in the static landing')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def validate_bundle(archive, expected_sha):
    packed, _ = regular_bytes(archive, MAX_TOTAL + 1024 * 1024)
    require(digest(packed) == expected_sha, 'Archive SHA-256 mismatch')
    entries = {}
    roots = 0
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(packed), mode='r:*') as bundle:
            for member in bundle:
                name = member.name
                if member.isdir() and name in {'.', './'}:
                    roots += 1
                    require(roots <= 1 and member.size == 0, 'Unexpected archive root directory')
                    continue
                require(member.isreg() and member.type in {tarfile.REGTYPE, tarfile.AREGTYPE}
                        and not member.sparse, 'Archive links, special files and sparse entries are forbidden')
                if name.startswith('./'):
                    name = name[2:]
                require(name and '/' not in name and '\\' not in name
                        and name not in {'.', '..'} and name not in entries,
                        'Archive contains a duplicate or unsafe path')
                require(len(entries) < 7, 'Too many archive files')
                approved = name in {'index.html', 'icon.png', 'download-qr.svg', 'download-qr.png', 'download-manifest.json'}
                require(approved or re.fullmatch(r'LoliCode-Android-[0-9A-Za-z.-]+\.apk', name)
                        or re.fullmatch(r'LoliCode-Mobile-Companion-[0-9A-Za-z.-]+-Windows-x64-Desktop-Preview\.zip', name),
                        'Unapproved archive file')
                bound = artifact_limit(name)
                require(0 < member.size <= bound, 'Unexpected archive entry length')
                total += member.size
                require(total <= MAX_TOTAL, 'Archive uncompressed length exceeds limit')
                stream = bundle.extractfile(member)
                require(stream is not None, 'Archive file cannot be read')
                with stream:
                    data = stream.read(bound + 1)
                require(len(data) == member.size and len(data) <= bound, 'Archive file length mismatch')
                if not name.endswith(('.apk', '.zip')):
                    require(not SECRETS.search(data), 'Credential-like material is forbidden in public assets')
                entries[name] = data
    except (tarfile.TarError, EOFError, OSError) as error:
        raise PublishError('Invalid or incomplete publication archive') from error
    required = {'index.html', 'icon.png', 'download-qr.svg', 'download-manifest.json'}
    require(required <= entries.keys(), 'Publication assets are missing')
    try:
        manifest = json.loads(entries['download-manifest.json'].decode('utf-8'), object_pairs_hook=unique_json)
    except (UnicodeError, ValueError) as error:
        raise PublishError('Invalid download manifest') from error
    expected_keys = {'schemaVersion', 'applicationId', 'version', 'channel', 'filename', 'bytes',
                     'sha256', 'certificateSha256', 'url', 'systemPush', 'lockscreenTest'}
    require(isinstance(manifest, dict), 'Invalid download manifest object')
    if 'desktopPreview' in manifest:
        expected_keys.add('desktopPreview')
    require(manifest.keys() == expected_keys, 'Unexpected download manifest fields')
    require(type(manifest['schemaVersion']) is int and manifest['schemaVersion'] == 1,
            'Unsupported download manifest schema')
    version = manifest['version']
    require(isinstance(version, str) and VERSION.fullmatch(version), 'Only explicit 0.x.y-alpha.n versions may be published')
    filename = 'LoliCode-Android-' + version + '.apk'
    url = 'https://lolicode.com/downloads/android/' + version + '/' + filename
    require(manifest['filename'] == filename and manifest['url'] == url, 'APK filename or public URL does not match the alpha version')
    require(manifest['applicationId'] == 'art.treasuregrove.lolicode.mobile' and manifest['channel'] == 'alpha', 'Wrong Android application or channel')
    require(manifest['systemPush'] == 'deferred' and manifest['lockscreenTest'] == 'pending', 'Current alpha must explicitly defer push and lockscreen acceptance')
    require(isinstance(manifest['certificateSha256'], str) and SHA256.fullmatch(manifest['certificateSha256']), 'Missing verified signing certificate fingerprint')
    require(isinstance(manifest['sha256'], str) and SHA256.fullmatch(manifest['sha256']), 'Invalid APK checksum')
    require(type(manifest['bytes']) is int and 1024 <= manifest['bytes'] <= MAX_APK, 'Invalid APK byte count')
    allowed = required | {filename, 'download-qr.png'}
    approved_urls = {'icon.png', 'download-qr.png', 'download-manifest.json', url, 'https://lolicode.com/'}
    desktop = manifest.get('desktopPreview')
    if 'desktopPreview' in manifest:
        require(isinstance(desktop, dict) and desktop.keys() == {'filename', 'bytes', 'sha256', 'url'},
                'Unexpected desktop preview manifest fields')
        desktop_name = 'LoliCode-Mobile-Companion-' + version + '-Windows-x64-Desktop-Preview.zip'
        desktop_url = 'https://lolicode.com/downloads/android/' + version + '/' + desktop_name
        require(desktop['filename'] == desktop_name and desktop['url'] == desktop_url,
                'Desktop preview must use the exact same-version Windows binary ZIP filename and URL')
        require(type(desktop['bytes']) is int and 1024 <= desktop['bytes'] <= MAX_DESKTOP
                and isinstance(desktop['sha256'], str) and SHA256.fullmatch(desktop['sha256']),
                'Invalid desktop preview length or SHA-256')
        require(desktop_name in entries, 'Manifest desktop preview ZIP is missing')
        # This is an already prepared binary distribution, never a source-tree
        # archive. Only its approved basename, container bytes, length and hash
        # are validated; the ZIP is never extracted or executed by the publisher.
        desktop_data = entries[desktop_name]
        require(desktop_data.startswith(b'PK\x03\x04') and len(desktop_data) == desktop['bytes']
                and digest(desktop_data) == desktop['sha256'].lower(), 'Actual desktop preview ZIP does not match its manifest')
        allowed.add(desktop_name)
        approved_urls.add(desktop_url)
    require(set(entries) <= allowed and filename in entries, 'Manifest must identify the only APK in the archive')
    apk = entries[filename]
    require(apk.startswith(b'PK\x03\x04') and len(apk) == manifest['bytes']
            and digest(apk) == manifest['sha256'].lower(), 'Actual APK bytes or SHA-256 do not match the manifest')
    for name in {'icon.png', 'download-qr.png'} & entries.keys():
        require(entries[name].startswith(b'\x89PNG\r\n\x1a\n'), 'Invalid PNG asset')
    svg = entries['download-qr.svg']
    require(b'<!DOCTYPE' not in svg.upper() and b'<!ENTITY' not in svg.upper(), 'SVG entity declarations are forbidden')
    try:
        root = xml.fromstring(svg)
        require(root.tag in {'svg', '{http://www.w3.org/2000/svg}svg'}, 'Invalid QR SVG root')
        for element in root.iter():
            require(element.tag.rsplit('}', 1)[-1].lower() in {'svg', 'path', 'rect', 'g'}, 'Unexpected active SVG element')
            for key in element.attrib:
                require(not key.lower().startswith('on') and not key.lower().endswith('href'), 'Active SVG attributes are forbidden')
        landing = entries['index.html'].decode('utf-8')
        LandingParser(approved_urls).feed(landing)
    except (xml.ParseError, UnicodeError) as error:
        raise PublishError('Invalid public landing or QR asset') from error
    require(url in landing and manifest['sha256'].lower() in landing
            and manifest['certificateSha256'].lower() in landing, 'Landing does not identify the actual APK and certificate checksums')
    if desktop is not None:
        require(desktop['url'] in landing and desktop['sha256'].lower() in landing,
                'Landing does not identify the actual desktop preview ZIP checksum')
    entries['SHA256SUMS'] = ''.join(digest(data) + '  ' + name + '\n'
                                  for name, data in sorted(entries.items())).encode('ascii')
    return manifest, entries


def snippet_plan(expected_sha):
    before, info = regular_bytes(SNIPPET, 128 * 1024)
    require(info.st_uid == 0 and not info.st_mode & 0o022, 'Nginx snippet is not root-controlled')
    has_marker = ('# BEGIN ' + MARKER).encode() in before or ('# END ' + MARKER).encode() in before
    if has_marker:
        require(before.endswith(LOCATIONS), 'Preserving an unexpected or modified managed location block')
        original = before[:-len(LOCATIONS)]
        require(MARKER.encode() not in original, 'Duplicate managed location blocks')
        # A repeated call may use either the current SHA or the originally
        # reviewed SHA after an unknown successful publication outcome.
        require(expected_sha in {digest(before), digest(original)}, 'Nginx snippet changed outside this publication')
        return before, before, info
    require(digest(before) == expected_sha, 'Nginx snippet changed; inspect it and re-plan with its current SHA-256')
    require(not re.search(rb'location\s+(?:=\s*|\^~\s*)?/(?:mobile(?:/|\s)|downloads/android/)', before),
            'Existing mobile/download routes have no matching ownership marker')
    return before, before + LOCATIONS, info


def current_mobile():
    path = PUBLIC / 'mobile'
    info = lstat(path)
    if info is None:
        return None
    require(stat.S_ISLNK(info.st_mode), 'Existing mobile entry is not this publisher\'s version symlink')
    target = os.readlink(path)
    parts = pathlib.PurePosixPath(target).parts
    require(len(parts) == 2 and parts[0] == 'releases' and VERSION.fullmatch(parts[1])
            and target == 'releases/' + parts[1], 'Mobile entry points outside the immutable alpha releases')
    owned_directory(PUBLIC / 'releases')
    owned_directory(PUBLIC / target)
    return target


def existing_release(version, entries):
    release = PUBLIC / 'releases' / version
    if lstat(release) is None:
        return False
    owned_directory(PUBLIC / 'releases')
    owned_directory(release)
    require({path.name for path in release.iterdir()} == set(entries), 'Existing immutable release has different or incomplete files')
    for name, data in entries.items():
        existing, info = regular_bytes(release / name, artifact_limit(name))
        require(info.st_uid == 0 and not info.st_mode & 0o022 and existing == data,
                'Refusing to overwrite different published bytes: ' + name)
    return True


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create_public_directory(path):
    # mkdir's requested mode is masked by umask; only our newly created public
    # directory is made readable/traversable by nginx. Existing paths are never
    # silently chmod'ed or claimed.
    path.mkdir(mode=0o755)
    path.chmod(0o755)


def write_new(path, data, mode):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
    try:
        with os.fdopen(descriptor, 'wb', closefd=False) as output:
            output.write(data)
            output.flush()
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def publication_lock():
    import fcntl
    descriptor = os.open(PUBLIC / '.publish.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0, 'Unsafe publication lock')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PublishError('Another Android publication is active; preserve its state and retry later') from error
        yield
    finally:
        os.close(descriptor)


def install_release(version, entries):
    releases = PUBLIC / 'releases'
    if lstat(releases) is None:
        create_public_directory(releases)
    owned_directory(releases)
    if existing_release(version, entries):
        return
    staging = PUBLIC / ('.pending-release-' + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    for name, data in entries.items():
        write_new(staging / name, data, 0o644)
    sync_directory(staging)
    staging.chmod(0o755)
    # All cooperating publishers hold the same lock. Never merge into or
    # replace an existing release, even one left by another deployment tool.
    require(lstat(releases / version) is None, 'A concurrent immutable release appeared; preserving both copies')
    os.rename(staging, releases / version)
    sync_directory(releases)


def set_mobile(expected, target):
    require(current_mobile() == expected, 'Concurrent mobile entry change; preserving it')
    link = PUBLIC / ('.pending-mobile-' + uuid.uuid4().hex)
    os.symlink(target, link)
    require(current_mobile() == expected, 'Concurrent mobile entry change; pending link retained for inspection')
    os.replace(link, PUBLIC / 'mobile')
    sync_directory(PUBLIC)


def replace_snippet(expected, content, original_info):
    actual, _ = regular_bytes(SNIPPET, 128 * 1024)
    require(actual == expected, 'Concurrent nginx snippet change; preserving it')
    temporary = SNIPPET.with_name('.lolicode-companion-download-' + uuid.uuid4().hex + '.conf.tmp')
    write_new(temporary, content, stat.S_IMODE(original_info.st_mode))
    os.chown(temporary, original_info.st_uid, original_info.st_gid)
    actual, _ = regular_bytes(SNIPPET, 128 * 1024)
    require(actual == expected, 'Concurrent nginx snippet change; pending config retained for inspection')
    os.replace(temporary, SNIPPET)
    sync_directory(SNIPPET.parent)


def run_nginx(*command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        detail = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', (result.stderr or result.stdout)[-2000:])
        raise PublishError('Command failed: ' + ' '.join(command) + ('; ' + detail.strip() if detail else ''))


def plan(manifest, entries, archive_sha, expected_snippet_sha):
    exists = validate_root()
    if exists and lstat(PUBLIC / 'releases') is not None:
        owned_directory(PUBLIC / 'releases')
    immutable_exists = existing_release(manifest['version'], entries) if exists else False
    mobile = current_mobile() if exists else None
    before, after, info = snippet_plan(expected_snippet_sha)
    result = {'plan': True, 'archiveSha256': archive_sha, 'publicRoot': str(PUBLIC),
              'version': manifest['version'], 'apkUrl': manifest['url'],
              'apkSha256': manifest['sha256'].lower(), 'apkBytes': manifest['bytes'],
              'landingUrl': 'https://lolicode.com/mobile/',
              'checksumsUrl': 'https://lolicode.com/downloads/android/' + manifest['version'] + '/SHA256SUMS',
              'immutableReleaseAlreadyMatches': immutable_exists, 'previousMobileTarget': mobile,
              'newMobileTarget': 'releases/' + manifest['version'],
              'snippet': str(SNIPPET), 'snippetBeforeSha256': digest(before), 'snippetAfterSha256': digest(after),
              'snippetAppendRequired': before != after, 'systemPush': 'deferred', 'lockscreenTest': 'pending',
              'files': {name: {'bytes': len(data), 'sha256': digest(data)} for name, data in sorted(entries.items())}}
    if 'desktopPreview' in manifest:
        result['desktopPreview'] = manifest['desktopPreview']
    return result, before, after, info


def activate(manifest, entries, archive_sha, expected_snippet_sha):
    require(os.name == 'posix' and os.geteuid() == 0, 'Activation must run as root on the existing Linux website host')
    if not validate_root():
        create_public_directory(PUBLIC)
        write_new(PUBLIC / 'owner', OWNER, 0o644)
        sync_directory(PUBLIC)
    with publication_lock():
        result, before, after, info = plan(manifest, entries, archive_sha, expected_snippet_sha)
        private = PUBLIC / 'private-receipts'
        if lstat(private) is None:
            private.mkdir(mode=0o700)
        owned_directory(private)
        require(not private.stat().st_mode & 0o077, 'Publication receipts must not be publicly readable')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
        write_new(private / ('nginx-before-' + stamp + '.conf'), before, 0o600)
        install_release(manifest['version'], entries)
        old_mobile = result['previousMobileTarget']
        target = result['newMobileTarget']
        mobile_changed = False
        snippet_changed = False
        reload_attempted = False
        try:
            if old_mobile != target:
                mobile_changed = True
                set_mobile(old_mobile, target)
            if before != after:
                snippet_changed = True
                replace_snippet(before, after, info)
            run_nginx('nginx', '-t')
            require(regular_bytes(SNIPPET, 128 * 1024)[0] == after, 'Nginx snippet changed during validation; not reloading it')
            require(current_mobile() == target, 'Mobile entry changed during validation; not activating it')
            reload_attempted = True
            run_nginx('systemctl', 'reload', 'nginx')
            require(regular_bytes(SNIPPET, 128 * 1024)[0] == after and current_mobile() == target,
                    'Concurrent change after reload; inspect live routing before retrying')
        except Exception as error:
            recovery = []
            if snippet_changed:
                try:
                    if regular_bytes(SNIPPET, 128 * 1024)[0] == after:
                        replace_snippet(after, before, info)
                        recovery.append('restored_own_snippet')
                    else:
                        recovery.append('preserved_concurrent_snippet_change')
                except Exception:
                    recovery.append('snippet_restore_requires_operator')
            if mobile_changed:
                try:
                    if current_mobile() == target:
                        if old_mobile is None:
                            # This removes only the still-matching symlink we
                            # created, never a directory or an immutable release.
                            (PUBLIC / 'mobile').unlink()
                            sync_directory(PUBLIC)
                        else:
                            set_mobile(target, old_mobile)
                        recovery.append('restored_own_mobile_entry')
                    else:
                        recovery.append('preserved_concurrent_mobile_change')
                except Exception:
                    recovery.append('mobile_restore_requires_operator')
            if reload_attempted and 'preserved_concurrent_snippet_change' not in recovery:
                try:
                    # Reapply only the original checked routing after restoring
                    # our own changes; never reload a concurrent config revision.
                    if regular_bytes(SNIPPET, 128 * 1024)[0] == before:
                        run_nginx('nginx', '-t')
                        run_nginx('systemctl', 'reload', 'nginx')
                        recovery.append('original_routing_reload_requested')
                except Exception:
                    recovery.append('routing_reload_requires_operator')
            failure = {'activated': False, 'version': manifest['version'], 'immutableFilesPreserved': True, 'recovery': recovery}
            write_new(private / ('failed-' + stamp + '.json'), (json.dumps(failure, indent=2) + '\n').encode(), 0o600)
            raise PublishError(str(error) + '; recovery=' + ','.join(recovery) + '; immutable files preserved') from error
        result.update({'plan': False, 'activated': True, 'nginxValidated': True, 'reloadRequested': True})
        write_new(private / ('published-' + stamp + '.json'), (json.dumps(result, indent=2) + '\n').encode(), 0o600)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True, help='SHA-256 of the uploaded tar, not the APK')
    parser.add_argument('--snippet-sha256', required=True, help='Reviewed current companion snippet SHA-256')
    parser.add_argument('--activate', action='store_true', help='Actually publish and reload nginx; default is read-only')
    args = parser.parse_args()
    require(SHA256.fullmatch(args.sha256) and SHA256.fullmatch(args.snippet_sha256), 'Both reviewed SHA-256 values are required')
    archive = pathlib.Path(os.path.abspath(args.archive))
    manifest, entries = validate_bundle(archive, args.sha256.lower())
    # Complete the read-only preflight before creating even our own namespace.
    result, _, _, _ = plan(manifest, entries, args.sha256.lower(), args.snippet_sha256.lower())
    if args.activate:
        result = activate(manifest, entries, args.sha256.lower(), args.snippet_sha256.lower())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        # Do not dump tar contents, credentials or an arbitrary Python traceback.
        message = str(failure) if isinstance(failure, (PublishError, FileNotFoundError, PermissionError)) else 'Publication failed; existing website and immutable releases were preserved. Inspect private receipts.'
        print(message, file=sys.stderr)
        sys.exit(1)
