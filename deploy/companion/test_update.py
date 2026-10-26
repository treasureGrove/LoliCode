import contextlib
import hashlib
import http.server
import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import tarfile
import tempfile
import threading
import types
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('companion_update', pathlib.Path(__file__).with_name('update.py'))
UPDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE)
REQUIRED = ('Dockerfile', 'package.json', 'package-lock.json', 'src/server.mjs', 'src/main.mjs',
            'src/accounts.mjs', 'src/account-http.mjs', 'src/account-validation.mjs', 'src/forum.mjs',
            'src/store.mjs', 'deploy/nginx-http.conf', 'deploy/nginx-locations.conf')


def bundle(path, extras=()):
    files = {name: ('audited fixture ' + name).encode() for name in REQUIRED}
    with tarfile.open(path, 'w:gz') as output:
        for name, data in [*files.items(), *extras]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))
    return files, UPDATE.digest(path.read_bytes())


class ArchiveTests(unittest.TestCase):
    def test_pinned_complete_archive_and_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'source.tar.gz'
            files, digest = bundle(path)
            self.assertEqual(UPDATE.archive_files(path, digest), files)
            with self.assertRaises(UPDATE.UpdateError):
                UPDATE.archive_files(path, 'a' * 64)

    def test_traversal_duplicates_hidden_secrets_and_conflicting_paths_are_refused(self):
        for name in ('../escape', '/tmp/escape', 'src//extra.mjs', 'src/../escape.mjs', 'src/.env',
                     'src/server.mjs', 'src/server.mjs/nested.mjs'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / 'source.tar.gz'
                _, digest = bundle(path, [(name, b'not accepted')])
                with self.assertRaises(UPDATE.UpdateError):
                    UPDATE.archive_files(path, digest)

    def test_links_and_oversized_expansion_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'source.tar.gz'
            with tarfile.open(path, 'w:gz') as output:
                info = tarfile.TarInfo('src/link.mjs')
                info.type = tarfile.SYMTYPE
                info.linkname = '/etc/passwd'
                output.addfile(info)
            with self.assertRaises(UPDATE.UpdateError):
                UPDATE.archive_files(path, UPDATE.digest(path.read_bytes()))
            _, digest = bundle(path, [('src/large.mjs', b'x' * (5 * 1024 * 1024))])
            with self.assertRaises(UPDATE.UpdateError):
                UPDATE.archive_files(path, digest)

    def test_atomic_config_cas_preserves_a_concurrent_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory).resolve() / 'routes.conf'
            path.write_bytes(b'original')
            original = UPDATE.exclusive

            def concurrent(target, data, mode):
                original(target, data, mode)
                path.write_bytes(b'concurrent edit')

            with mock.patch.object(UPDATE, 'exclusive', side_effect=concurrent):
                with self.assertRaisesRegex(UPDATE.UpdateError, 'Concurrent'):
                    UPDATE.atomic_replace(path, b'new routes', path.stat(), expected=b'original')
            self.assertEqual(path.read_bytes(), b'concurrent edit')

    def test_probe_rejects_redirect_and_bounds_response_without_following(self):
        calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('location', '/target')
                    self.end_headers()
                elif self.path == '/private-error':
                    self.send_response(403)
                    self.send_header('content-type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"error":{"code":"private_provider_token","message":"TOP_SECRET_PROVIDER_BODY"}}')
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'x' * 4097 if self.path == '/large' else b'{"ok":true}')

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = 'http://127.0.0.1:' + str(server.server_port)
            self.assertEqual(UPDATE.probe(base + '/target'), {'ok': True})
            calls.clear()
            with self.assertRaises(UPDATE.UpdateError):
                UPDATE.probe(base + '/redirect')
            self.assertEqual(calls, ['/redirect'])
            with self.assertRaises(UPDATE.UpdateError):
                UPDATE.probe(base + '/large')
            with self.assertRaises(UPDATE.ProbeError) as failure:
                UPDATE.probe(base + '/private-error', 401)
            self.assertEqual(failure.exception.details['actualStatus'], 403)
            self.assertEqual(failure.exception.details['contentType'], 'application/json')
            self.assertIsNone(failure.exception.details['errorCode'])
            self.assertNotIn('TOP_SECRET', json.dumps(failure.exception.details))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class FakeDocker:
    """No real Docker commands: state-machine fault injection around real files."""
    def __init__(self, base, expected_id):
        self.base, self.expected_id = base, expected_id
        self.old = {'imageId': expected_id, 'image': 'lolicode-companion:0.1.0-alpha.1', 'owner': UPDATE.OWNER,
                    'running': True, 'network': 'host', 'readOnly': True,
                    'mounts': [{'Type': 'bind', 'Source': str(base / 'state'), 'Destination': '/var/lib/lolicode-companion', 'RW': True}]}
        self.current = dict(self.old)
        self.saved = {}
        self.calls = []
        self.fail_nginx_once = False
        self.fail_stop_after_effect = False
        self.replace_after_stop_failure = False
        self.fail_rename_after_effect = False
        self.public_route_failures = 0
        self.wrong_error_body = False

    def __call__(self, *args, check=True, timeout=600):
        self.calls.append(args)
        result = subprocess.CompletedProcess(args, 0, '', '')
        if args[:2] == ('docker', 'inspect'):
            container = self.current if args[-1] == UPDATE.NAME else self.saved.get(args[-1])
            if container is None:
                result.returncode = 1
            else:
                result.stdout = json.dumps(container)
        elif args[:3] == ('docker', 'image', 'inspect'):
            result.returncode = 1
        elif args[:2] == ('docker', 'stop'):
            self.current['running'] = False
            if self.fail_stop_after_effect:
                self.fail_stop_after_effect = False
                if self.replace_after_stop_failure:
                    self.current = {**self.current, 'owner': 'foreign-owner', 'imageId': 'sha256:' + 'c' * 64}
                raise UPDATE.UpdateError('Injected stop CLI error after actual effect')
        elif args[:2] == ('docker', 'rename'):
            before, after = args[2:]
            if before == UPDATE.NAME:
                self.saved[after] = self.current
                self.current = None
                if self.fail_rename_after_effect:
                    self.fail_rename_after_effect = False
                    raise UPDATE.UpdateError('Injected rename error after actual effect')
            else:
                self.current = self.saved.pop(before)
        elif args[:2] == ('docker', 'run'):
            self.current = {**self.old, 'imageId': 'sha256:' + 'b' * 64, 'image': args[-1], 'running': True}
            (self.base / 'state' / 'rooms.json').write_bytes(b'{"v":2,"fixture":"new-private-state"}')
        elif args[:2] == ('docker', 'start'):
            self.current['running'] = True
        elif args == ('nginx', '-t') and self.fail_nginx_once:
            self.fail_nginx_once = False
            raise UPDATE.UpdateError('Injected nginx failure')
        return result

    def probe(self, url, expected_status=200):
        if expected_status == 401:
            if self.public_route_failures:
                self.public_route_failures -= 1
                raise UPDATE.ProbeError({'endpoint': 'devices', 'expectedStatus': 401, 'actualStatus': 404,
                                         'contentType': 'text/html', 'errorCode': None, 'failure': 'invalid_json'})
            if self.wrong_error_body:
                return {'error': {'code': 'unauthorized', 'message': 'wrong response'}}
            return {'error': {'code': 'unauthorized', 'message': 'Authentication required.'}}
        if self.current and self.current['image'].startswith('lolicode-companion:account-v2-'):
            return {'ok': True, 'ready': True, 'protocol': 1, 'accountProtocol': 2,
                    'transportPolicy': 'directOnly', 'legacyDataRelay': False, 'pushConfigured': False}
        return {'ok': True, 'ready': True, 'protocol': 1, 'pushConfigured': False}


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'Lifecycle tests require isolated Linux root fixtures for real uid/gid/modes')
class LifecycleTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            base = root / 'companion'
            base.mkdir(mode=0o700)
            UPDATE.exclusive(base / 'owner', UPDATE.OWNER.encode())
            state = base / 'state'
            state.mkdir(mode=0o700)
            os.chown(state, 1000, 1000)
            for name, data in [('push-state.key', b'fixture-key-never-log'.ljust(32, b'x')), ('rooms.json', b'{"v":1,"rooms":[]}')]:
                UPDATE.exclusive(state / name, data)
                os.chown(state / name, 1000, 1000)
            site, rates, locations = (root / name for name in ('site.conf', 'rates.conf', 'locations.conf'))
            site.write_bytes(b'include /etc/nginx/snippets/lolicode-companion.conf;\n')
            rates.write_bytes(b'old rates')
            locations.write_bytes(b'old locations')
            archive = root / 'source.tar.gz'
            _, digest = bundle(archive)
            args = types.SimpleNamespace(archive=str(archive), sha256=digest, site_sha256=UPDATE.digest(site.read_bytes()),
                                         rates_sha256=UPDATE.digest(rates.read_bytes()), locations_sha256=UPDATE.digest(locations.read_bytes()),
                                         expected_image_id='sha256:' + 'a' * 64)
            fake = FakeDocker(base, args.expected_image_id)
            with mock.patch.multiple(UPDATE, BASE=base, SITE=site, RATES=rates, LOCATIONS=locations):
                update = UPDATE.Update(args, run=fake, check_endpoint=fake.probe)
                yield update, fake, root

    def test_plan_is_read_only_and_pins_owner_image_mount_configs(self):
        with self.fixture() as (update, fake, root):
            before = {str(path): path.read_bytes() for path in root.rglob('*') if path.is_file()}
            plan = update.plan()
            self.assertEqual(plan['transportPolicy'], 'directOnly')
            self.assertFalse(plan['stunActivation'])
            self.assertEqual(before, {str(path): path.read_bytes() for path in root.rglob('*') if path.is_file()})
            self.assertTrue(all(call[:2] == ('docker', 'inspect') for call in fake.calls))
            fake.current['owner'] = 'unrelated-owner'
            with self.assertRaises(UPDATE.UpdateError):
                update.plan()

    def test_hash_image_and_mount_cas_reject_without_stopping(self):
        for mutate in (lambda u, f: setattr(u.args, 'site_sha256', '0' * 64),
                       lambda u, f: f.current.update(imageId='sha256:' + 'c' * 64),
                       lambda u, f: f.current['mounts'][0].update(Source='/unrelated/state')):
            with self.subTest(mutate=mutate), self.fixture() as (update, fake, _):
                mutate(update, fake)
                with self.assertRaises(UPDATE.UpdateError):
                    update.plan()
                self.assertFalse(any(call[:2] == ('docker', 'stop') for call in fake.calls))

    def test_atomic_backup_contains_only_private_owned_state_and_config(self):
        with self.fixture() as (update, _, _):
            update.plan()
            backup = update.backup_bundle()
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
            self.assertEqual((backup / 'state' / 'rooms.json').read_bytes(), b'{"v":1,"rooms":[]}')
            for path in backup.rglob('*'):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
            manifest = (backup / 'manifest.json').read_text()
            self.assertNotIn('fixture-key-never-log', manifest)
            self.assertFalse(any(path.name.startswith('.pending') for path in backup.parent.iterdir()))

    def test_activation_success_keeps_prior_container_and_matching_backup(self):
        with self.fixture() as (update, fake, root):
            update.plan()
            result = update.activate()
            self.assertTrue(result['updated'])
            self.assertEqual(update.phase, 'complete')
            self.assertEqual((root / 'site.conf').read_bytes(), update.original[UPDATE.SITE][0])
            self.assertIn(UPDATE.NAME + '-before-' + update.identifier, fake.saved)
            self.assertTrue(fake.current['running'])
            self.assertEqual((update.backup / 'state' / 'rooms.json').read_bytes(), b'{"v":1,"rooms":[]}')
            self.assertNotIn('fixture-key-never-log', json.dumps(result))
            self.assertNotIn('new-private-state', json.dumps(result))

    def test_nginx_failure_rolls_back_matching_state_and_preserves_failed_new_state(self):
        with self.fixture() as (update, fake, root):
            update.plan()
            fake.fail_nginx_once = True
            with self.assertRaises(UPDATE.UpdateError):
                update.activate()
            self.assertEqual(update.phase, 'nginx-rolled-back')
            self.assertEqual(fake.current['imageId'], update.args.expected_image_id)
            self.assertTrue(fake.current['running'])
            self.assertEqual((UPDATE.BASE / 'state' / 'rooms.json').read_bytes(), b'{"v":1,"rooms":[]}')
            self.assertIn(b'new-private-state', (update.backup / 'failed-state' / 'rooms.json').read_bytes())
            self.assertEqual((root / 'rates.conf').read_bytes(), b'old rates')
            self.assertEqual((root / 'locations.conf').read_bytes(), b'old locations')
            self.assertIn(UPDATE.NAME + '-failed-' + update.identifier, fake.saved)

    def test_stop_after_effect_failure_recovers_owned_baseline_without_touching_state(self):
        with self.fixture() as (update, fake, _):
            update.plan()
            original = (UPDATE.BASE / 'state' / 'rooms.json').read_bytes()
            fake.fail_stop_after_effect = True
            with self.assertRaises(UPDATE.UpdateError):
                update.activate()
            self.assertEqual(update.phase, 'backup-rolled-back')
            self.assertEqual(fake.current['imageId'], update.args.expected_image_id)
            self.assertTrue(fake.current['running'])
            self.assertEqual((UPDATE.BASE / 'state' / 'rooms.json').read_bytes(), original)
            self.assertFalse(any(call[:2] == ('docker', 'rename') for call in fake.calls))
            self.assertFalse(any(call[:2] == ('docker', 'run') for call in fake.calls))

    def test_failed_stop_never_starts_a_replaced_foreign_container(self):
        with self.fixture() as (update, fake, _):
            update.plan()
            fake.fail_stop_after_effect = True
            fake.replace_after_stop_failure = True
            with self.assertRaises(UPDATE.UpdateError):
                update.activate()
            self.assertEqual(update.phase, 'backup-rollback-needs-attention')
            self.assertFalse(any(call[:2] == ('docker', 'start') for call in fake.calls))
            self.assertFalse(any(call[:2] == ('docker', 'rename') for call in fake.calls))

    def test_rename_after_effect_failure_finds_and_restores_the_owned_baseline(self):
        with self.fixture() as (update, fake, _):
            update.plan()
            fake.fail_rename_after_effect = True
            with self.assertRaises(UPDATE.UpdateError):
                update.activate()
            self.assertEqual(update.phase, 'backup-rolled-back')
            self.assertTrue(fake.current['running'])
            self.assertEqual(fake.current['imageId'], update.args.expected_image_id)
            self.assertFalse(any(call[:2] == ('docker', 'run') for call in fake.calls))

    def test_async_nginx_route_readiness_retries_only_gets_and_records_first_mismatch(self):
        with self.fixture() as (update, fake, _):
            update.plan()
            fake.public_route_failures = 2
            with mock.patch.object(UPDATE.time, 'sleep', return_value=None):
                result = update.activate()
            self.assertTrue(result['updated'])
            self.assertEqual(result['publicProbeAttempts'], 3)
            self.assertEqual(result['firstMismatch']['actualStatus'], 404)
            self.assertEqual(result['firstMismatch']['contentType'], 'text/html')

    def test_persistent_public_failure_preserves_diagnostic_and_rolls_back(self):
        with self.fixture() as (update, fake, _):
            update.plan()
            fake.public_route_failures = 100
            with mock.patch.object(UPDATE.time, 'sleep', return_value=None):
                with self.assertRaises(UPDATE.UpdateError):
                    update.activate()
            self.assertEqual(update.phase, 'public-smoke-rolled-back')
            self.assertEqual(update.public_attempts, 10)
            self.assertEqual(fake.current['imageId'], update.args.expected_image_id)
            self.assertTrue(fake.current['running'])
            receipt = json.loads((update.backup / 'failure.json').read_text())
            self.assertEqual(receipt['diagnostic']['actualStatus'], 404)
            self.assertEqual(receipt['firstMismatch']['contentType'], 'text/html')

    def test_exact_401_body_is_never_relaxed_by_readiness_retries(self):
        with self.fixture() as (update, fake, _):
            update.plan()
            fake.wrong_error_body = True
            with mock.patch.object(UPDATE.time, 'sleep', return_value=None):
                with self.assertRaises(UPDATE.UpdateError):
                    update.activate()
            self.assertEqual(update.phase, 'public-smoke-rolled-back')
            self.assertEqual(update.public_attempts, 10)
            self.assertEqual(update.diagnostic['failure'], 'error_schema_mismatch')
            self.assertTrue(fake.current['running'])


if __name__ == '__main__':
    unittest.main()
