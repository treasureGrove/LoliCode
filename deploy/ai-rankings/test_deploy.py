"""Installer tests are local and never connect to a server or provider."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('rankings_deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.chown = patch.object(deploy.os, 'chown', create=True)
        self.fchown = patch.object(deploy.os, 'fchown', create=True)
        self.chown.start()
        self.fchown.start()

    def tearDown(self):
        self.fchown.stop()
        self.chown.stop()
        self.temp.cleanup()

    def test_dry_run_does_not_ssh_or_consume_credentials(self):
        output = io.StringIO()
        with patch.object(deploy.subprocess, 'run', side_effect=AssertionError('No SSH during dry run')), \
                patch.object(deploy.sys, 'stdin', None), contextlib.redirect_stdout(output):
            self.assertEqual(deploy.main(['--host', 'lolicode', '--dry-run', '--credential-stdin', '--run-now']), 0)
        value = json.loads(output.getvalue())
        self.assertFalse(value['sshExecuted'])
        self.assertEqual(value['schedule'], '09:00 Asia/Singapore daily')
        self.assertTrue(value['runRequested'])
        self.assertNotIn('apiKey', output.getvalue())

    def test_credentials_only_enter_stdin_payload_not_command_argv(self):
        source = self.root / 'deploy' / 'ai-rankings'
        source.mkdir(parents=True)
        for name in ('deploy.py', 'job.py', 'sources.py', 'glm_research.py', deploy.SERVICE, deploy.TIMER, 'nginx.conf'):
            (source / name).write_text('# fixture\n', encoding='utf8')
        seed = self.root / 'src/lib/data/ai-rankings.json'
        seed.parent.mkdir(parents=True)
        seed.write_text('{"models":[]}', encoding='utf8')
        secret = 'test-only-credential-never-output'
        value = deploy.build_payload({'apiKey': secret, 'model': 'glm-5'}, True, source)
        command = deploy.ssh_command('lolicode')
        self.assertIn(secret, json.dumps(value))
        self.assertNotIn(secret, ' '.join(command))
        self.assertNotIn('apiKey', ' '.join(command))
        self.assertIn('BatchMode=yes', command)
        self.assertEqual(value['credential']['model'], 'glm-5')
        self.assertEqual(set(value['files']), {'job.py', 'sources.py', 'glm_research.py'})
        self.assertEqual(base64.b64decode(value['seed']), b'{"models":[]}')
        for host in ('-oProxyCommand=oops', 'root@host;rm', 'host name', 'x\ny'):
            with self.assertRaises(deploy.DeployError):
                deploy.ssh_command(host)

    def test_credential_validation_never_echoes_the_key(self):
        secret = 'test-secret'
        self.assertEqual(deploy.credential_value({'apiKey': secret})['apiKey'], secret)
        for value in ({'apiKey': ''}, {'apiKey': secret + '\n'}, {'apiKey': secret, 'extra': secret}, {'apiKey': secret, 'model': 'bad\nmodel'}):
            with self.assertRaises(deploy.DeployError) as raised:
                deploy.credential_value(value)
            self.assertNotIn(secret, str(raised.exception))

    def test_refuses_unowned_directories_and_global_files(self):
        existing = self.root / 'existing'
        existing.mkdir()
        untouched = existing / 'user-data'
        untouched.write_bytes(b'preserve')
        with self.assertRaises(deploy.DeployError):
            deploy.owner_directory(existing)
        self.assertEqual(untouched.read_bytes(), b'preserve')
        path = self.root / 'foreign.service'
        path.write_bytes(b'[Service]\nExecStart=other\n')
        with self.assertRaises(deploy.DeployError):
            deploy.managed_global(path, ('# Managed by ' + deploy.OWNER + '\n[Service]\n').encode(), self.root)
        self.assertEqual(path.read_bytes(), b'[Service]\nExecStart=other\n')
        with self.assertRaises(deploy.DeployError):
            deploy.managed_global(self.root / 'new.service', b'[Service]\n', self.root)

    def test_site_addition_is_exact_and_idempotent(self):
        before = b'server {\n    include /etc/nginx/snippets/lolicode-companion.conf;\n    location / { proxy_pass http://community; }\n}\n'
        changed = deploy.site_with_include(before)
        self.assertEqual(deploy.site_with_include(changed), changed)
        self.assertIn(b'location / { proxy_pass http://community; }', changed)
        self.assertEqual(changed.count(b'include /etc/nginx/snippets/lolicode-ai-rankings.conf;'), 1)
        self.assertTrue(changed.index(b'lolicode-companion.conf;') < changed.index(b'# BEGIN ' + deploy.OWNER.encode()))
        for invalid in (before.replace(b'lolicode-companion.conf', b'other.conf'), before + before,
                        before.replace(b'    location /', b'    include /etc/nginx/snippets/lolicode-ai-rankings.conf;\n    location /')):
            with self.assertRaises(deploy.DeployError):
                deploy.site_with_include(invalid)

    def nginx_fixture(self):
        site = self.root / 'lolicode.conf'
        snippet = self.root / 'rankings.conf'
        backups = self.root / 'backups'
        backups.mkdir()
        before = b'server {\n    include /etc/nginx/snippets/lolicode-companion.conf;\n}\n'
        site.write_bytes(before)
        desired = ('# Managed by ' + deploy.OWNER + '\nlocation = /desktop-assets/ai-rankings.json {}\n').encode()
        return site, snippet, backups, before, desired

    def test_failed_nginx_validation_restores_site_and_removes_only_new_owned_snippet(self):
        site, snippet, backups, before, desired = self.nginx_fixture()
        with patch.object(deploy, 'SITE', site), patch.object(deploy, 'SNIPPET', snippet), \
                patch.object(deploy, 'run', side_effect=deploy.DeployError('nginx test failed')):
            with self.assertRaisesRegex(deploy.DeployError, 'original configuration restored'):
                deploy.activate_nginx(before, deploy.site_with_include(before), desired, backups)
        self.assertEqual(site.read_bytes(), before)
        self.assertFalse(snippet.exists())
        self.assertTrue(list(backups.iterdir()))

    def test_failed_reload_restores_owned_snippet_and_reloads_original_site(self):
        site, snippet, backups, before, desired = self.nginx_fixture()
        original = ('# Managed by ' + deploy.OWNER + '\n# previous owned snippet\n').encode()
        snippet.write_bytes(original)
        calls = []
        def execute(*args):
            calls.append(args)
            if args == ('systemctl', 'reload', 'nginx') and calls.count(args) == 1:
                raise deploy.DeployError('reload failed')
            return subprocess.CompletedProcess(args, 0, b'', b'')
        with patch.object(deploy, 'SITE', site), patch.object(deploy, 'SNIPPET', snippet), patch.object(deploy, 'run', side_effect=execute):
            with self.assertRaisesRegex(deploy.DeployError, 'original configuration restored'):
                deploy.activate_nginx(before, deploy.site_with_include(before), desired, backups)
        self.assertEqual(site.read_bytes(), before)
        self.assertEqual(snippet.read_bytes(), original)
        self.assertEqual(calls.count(('systemctl', 'reload', 'nginx')), 2)

    def test_concurrent_site_change_is_preserved_during_failed_activation(self):
        site, snippet, backups, before, desired = self.nginx_fixture()
        concurrent = b'# a concurrent operator update\n'
        def execute(*_args):
            site.write_bytes(concurrent)
            raise deploy.DeployError('nginx test failed')
        with patch.object(deploy, 'SITE', site), patch.object(deploy, 'SNIPPET', snippet), patch.object(deploy, 'run', side_effect=execute):
            with self.assertRaisesRegex(deploy.DeployError, 'concurrent changes'):
                deploy.activate_nginx(before, deploy.site_with_include(before), desired, backups)
        self.assertEqual(site.read_bytes(), concurrent)

    def archive(self, members):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name, content, kind in members:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        encoded = data.getvalue()
        return encoded, {'name': deploy.PACKAGE, 'version': deploy.VERSION,
                         'dist': {'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(encoded).digest()).decode()}}

    def test_official_binary_requires_sha512_and_exact_safe_tar_member(self):
        archive, metadata = self.archive([('package/package.json', b'{}', tarfile.REGTYPE),
                                          ('package/bin/opencode', b'verified-binary', tarfile.REGTYPE)])
        self.assertEqual(deploy.verified_binary(metadata, archive), b'verified-binary')
        with self.assertRaises(deploy.DeployError):
            deploy.verified_binary(metadata, archive + b'corrupt')
        for members in ([('package/bin/opencode', b'', tarfile.SYMTYPE)],
                        [('package/bin/opencode', b'one', tarfile.REGTYPE), ('package/bin/opencode', b'two', tarfile.REGTYPE)],
                        [('../bin/opencode', b'bad', tarfile.REGTYPE)]):
            archive, metadata = self.archive(members)
            with self.assertRaises(deploy.DeployError):
                deploy.verified_binary(metadata, archive)

    def test_units_and_route_are_scoped_to_daily_public_feed(self):
        timer = Path(__file__).with_name(deploy.TIMER).read_text()
        service = Path(__file__).with_name(deploy.SERVICE).read_text()
        nginx = Path(__file__).with_name('nginx.conf').read_text()
        self.assertIn('OnCalendar=*-*-* 09:00:00 Asia/Singapore', timer)
        self.assertIn('Persistent=true', timer)
        self.assertIn('User=lolicode-rankings', service)
        self.assertIn('LoadCredential=glm.json:/etc/lolicode-ai-rankings/glm.json', service)
        self.assertEqual([line for line in service.splitlines() if line.startswith('ReadWritePaths=')],
                         ['ReadWritePaths=/var/lib/lolicode-ai-rankings'])
        self.assertIn('ProtectSystem=strict', service)
        self.assertIn('PYTHONDONTWRITEBYTECODE=1', service)
        self.assertNotIn('apiKey=', service)
        self.assertIn('location = /desktop-assets/ai-rankings.json', nginx)
        self.assertIn('limit_except GET HEAD { deny all; }', nginx)
        self.assertIn('Access-Control-Allow-Origin "*" always', nginx)
        self.assertIn('max-age=300', nginx)
        self.assertIn('nosniff', nginx)


if __name__ == '__main__':
    unittest.main()
