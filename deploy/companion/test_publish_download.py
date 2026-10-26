"""Pure local validation tests: never publish, reload nginx or use SSH."""
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import MagicMock, call, patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('companion_download_publisher', pathlib.Path(__file__).with_name('publish-download.py'))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class DownloadValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='lolicode-download-publisher-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)

    def fixture(self, desktop=True):
        version = '0.1.0-alpha.1'
        apk_name = 'LoliCode-Android-' + version + '.apk'
        desktop_name = 'LoliCode-Mobile-Companion-' + version + '-Windows-x64-Desktop-Preview.zip'
        apk = b'PK\x03\x04' + b'A' * 2044
        preview = b'PK\x03\x04' + b'B' * 4092
        manifest = {'schemaVersion': 1, 'applicationId': 'art.treasuregrove.lolicode.mobile',
                    'version': version, 'channel': 'alpha', 'filename': apk_name,
                    'bytes': len(apk), 'sha256': publisher.digest(apk), 'certificateSha256': 'a' * 64,
                    'url': 'https://lolicode.com/downloads/android/' + version + '/' + apk_name,
                    'systemPush': 'deferred', 'lockscreenTest': 'pending'}
        entries = {apk_name: apk, 'icon.png': b'\x89PNG\r\n\x1a\n' + b'image',
                   'download-qr.png': b'\x89PNG\r\n\x1a\n' + b'qr',
                   'download-qr.svg': b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'}
        if desktop:
            manifest['desktopPreview'] = {'filename': desktop_name, 'bytes': len(preview),
                                          'sha256': publisher.digest(preview),
                                          'url': 'https://lolicode.com/downloads/android/' + version + '/' + desktop_name}
            entries[desktop_name] = preview
        self.refresh(manifest, entries)
        return manifest, entries

    @staticmethod
    def refresh(manifest, entries):
        entries['download-manifest.json'] = json.dumps(manifest).encode()
        desktop = manifest.get('desktopPreview')
        html = '<!doctype html><html><img src="icon.png"><img src="download-qr.png"><a href="' + manifest['url'] + '">APK</a>'
        html += manifest['sha256'] + manifest['certificateSha256']
        if desktop:
            html += '<a href="' + desktop['url'] + '">Desktop</a>' + desktop['sha256']
        entries['index.html'] = (html + '</html>').encode()

    def archive(self, entries, extra=None):
        path = self.root / ('fixture-' + str(len(list(self.root.iterdir()))) + '.tar.gz')
        with tarfile.open(path, 'w:gz') as tar:
            for name, data in entries.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            if extra is not None:
                tar.addfile(extra, io.BytesIO(b'x' * extra.size) if extra.isfile() else None)
        return path, publisher.digest(path.read_bytes())

    def validate(self, entries, extra=None):
        path, sha = self.archive(entries, extra)
        return publisher.validate_bundle(path, sha)

    def test_optional_desktop_and_all_seven_files_validate_without_extracting_zip(self):
        for desktop in (False, True):
            with self.subTest(desktop=desktop):
                manifest, entries = self.fixture(desktop)
                before = set(self.root.iterdir())
                result, public = self.validate(entries)
                self.assertEqual(manifest, result)
                self.assertEqual(len(public), 8 if desktop else 7)
                self.assertIn('SHA256SUMS', public)
                self.assertTrue(all(item.suffix == '.gz' for item in set(self.root.iterdir()) - before))
                checksums = public['SHA256SUMS'].decode()
                for name, data in entries.items():
                    self.assertIn(publisher.digest(data) + '  ' + name + '\n', checksums)

    def test_actual_apk_and_desktop_bytes_must_match_manifest(self):
        for artifact in ('filename', 'desktopPreview'):
            manifest, entries = self.fixture()
            name = manifest['filename'] if artifact == 'filename' else manifest['desktopPreview']['filename']
            entries[name] += b'tamper'
            with self.assertRaisesRegex(publisher.PublishError, 'Actual .* match'):
                self.validate(entries)

    def test_wrong_preview_name_version_url_fields_and_missing_binary_are_rejected(self):
        for field, value in (('filename', 'source.zip'), ('filename', 'LoliCode-Mobile-Companion-0.1.0-alpha.2-Windows-x64-Desktop-Preview.zip'),
                             ('url', 'https://example.invalid/source.zip'), ('bytes', True), ('sha256', 'bad')):
            manifest, entries = self.fixture()
            manifest['desktopPreview'][field] = value
            self.refresh(manifest, entries)
            with self.assertRaises(publisher.PublishError):
                self.validate(entries)
        manifest, entries = self.fixture()
        del entries[manifest['desktopPreview']['filename']]
        with self.assertRaisesRegex(publisher.PublishError, 'ZIP is missing'):
            self.validate(entries)

    def test_source_archive_unknown_manifest_fields_and_undeclared_zip_are_rejected(self):
        manifest, entries = self.fixture()
        info = tarfile.TarInfo('source.zip')
        info.size = 16
        with self.assertRaisesRegex(publisher.PublishError, 'Too many|Unapproved'):
            self.validate(entries, info)
        manifest['desktopPreview']['sourcePath'] = 'private/local/source'
        self.refresh(manifest, entries)
        with self.assertRaisesRegex(publisher.PublishError, 'Unexpected desktop'):
            self.validate(entries)
        manifest, entries = self.fixture()
        del manifest['desktopPreview']
        self.refresh(manifest, entries)
        with self.assertRaisesRegex(publisher.PublishError, 'Manifest must identify'):
            self.validate(entries)

    def test_symlink_hardlink_traversal_duplicate_and_source_files_are_rejected(self):
        for name, kind in (('../source.rs', tarfile.REGTYPE), ('/private.key', tarfile.REGTYPE),
                           ('src/main.rs', tarfile.REGTYPE), ('icon.png', tarfile.REGTYPE),
                           ('link.png', tarfile.SYMTYPE), ('hard.png', tarfile.LNKTYPE)):
            _, entries = self.fixture(False)
            info = tarfile.TarInfo(name)
            info.type = kind
            info.linkname = 'index.html'
            info.size = 1 if kind == tarfile.REGTYPE else 0
            with self.subTest(name=name), self.assertRaises(publisher.PublishError):
                self.validate(entries, info)

    def test_archive_hash_invalid_container_and_secret_asset_are_rejected(self):
        manifest, entries = self.fixture()
        archive, _ = self.archive(entries)
        with self.assertRaisesRegex(publisher.PublishError, 'Archive SHA'):
            publisher.validate_bundle(archive, '0' * 64)
        entries[manifest['desktopPreview']['filename']] = b'X' * manifest['desktopPreview']['bytes']
        manifest['desktopPreview']['sha256'] = publisher.digest(entries[manifest['desktopPreview']['filename']])
        self.refresh(manifest, entries)
        with self.assertRaisesRegex(publisher.PublishError, 'Actual desktop'):
            self.validate(entries)
        _, entries = self.fixture()
        entries['index.html'] += b'-----BEGIN PRIVATE KEY-----'
        with self.assertRaisesRegex(publisher.PublishError, 'Credential-like'):
            self.validate(entries)

    def test_snippet_retry_recovers_exact_owned_suffix_but_preserves_concurrent_changes(self):
        before = b'location = /companion/ws { proxy_pass http://127.0.0.1:13010/companion; }\n'
        info = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o644)
        with patch.object(publisher, 'regular_bytes', return_value=(before, info)):
            original, after, _ = publisher.snippet_plan(publisher.digest(before))
            self.assertEqual(original, before)
            self.assertEqual(after, before + publisher.LOCATIONS)
        with patch.object(publisher, 'regular_bytes', return_value=(after, info)):
            self.assertEqual(publisher.snippet_plan(publisher.digest(before))[:2], (after, after))
            self.assertEqual(publisher.snippet_plan(publisher.digest(after))[:2], (after, after))
        with patch.object(publisher, 'regular_bytes', return_value=(after + b'# concurrent change\n', info)):
            with self.assertRaises(publisher.PublishError):
                publisher.snippet_plan(publisher.digest(before))
        self.assertIn(b'application/zip zip;', publisher.LOCATIONS)
        self.assertIn(b'(?:apk|zip)$', publisher.LOCATIONS)
        self.assertNotIn(b'autoindex on', publisher.LOCATIONS)

    def test_new_public_directories_explicitly_apply_readable_mode_after_mkdir(self):
        path = MagicMock()
        publisher.create_public_directory(path)
        self.assertEqual(path.mock_calls, [call.mkdir(mode=0o755), call.chmod(0o755)])

    @unittest.skipUnless(os.name == 'posix', 'POSIX modes must be verified on the Linux publishing host')
    def test_umask_0077_does_not_hide_new_public_directories(self):
        previous = os.umask(0o077)
        try:
            directory = self.root / 'public'
            publisher.create_public_directory(directory)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
        finally:
            os.umask(previous)


if __name__ == '__main__':
    unittest.main()
