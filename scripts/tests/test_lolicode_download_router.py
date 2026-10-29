import copy
import http.client
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location(
    'lolicode_download_router', Path(__file__).parents[1] / 'release' / 'lolicode-download-router.py')
router = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = router
spec.loader.exec_module(router)


def fixture():
    return {'schema': 1, 'r2_origin': router.ORIGIN, 'releases': [
        {'version': version, 'assets': {name: {'bytes': 100, 'sha256': 'a' * 64}
            for name in [f'LoliCode-{version}-Windows-x64-Setup.exe',
                         f'LoliCode-{version}-Windows-x64-Setup.exe.sig', 'LoliCode-Portable.zip']}}
        for version in ['4.0.20', '4.0.21']]}


def configuration(data=None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'config.json'
        path.write_text(json.dumps(data if data is not None else fixture()))
        return router.load_configuration(path)


class ConfigurationTests(unittest.TestCase):
    def test_coexisting_versions_keep_their_own_three_assets(self):
        config = configuration()
        self.assertEqual(len(config.assets), 6)
        for version in ['4.0.20', '4.0.21']:
            route = f'/downloads/releases/{version}/LoliCode-Portable.zip'
            asset = config.assets[route]
            self.assertEqual(asset.r2_url, router.ORIGIN + f'/lolicode/releases/{version}/LoliCode-Portable.zip')
            self.assertEqual(asset.github_url, router.GITHUB + f'{version}/LoliCode-Portable.zip')

    def test_origins_versions_extra_fields_and_duplicates_fail_closed(self):
        bad = []
        for origin in ['http://example.com', router.ORIGIN + ':443', router.ORIGIN + '/other',
                       router.ORIGIN + '.evil', router.ORIGIN + '?secret=1']:
            value = fixture()
            value['r2_origin'] = origin
            bad.append(value)
        for version in ['../4.0.21', '4.0.21-rc.2', '04.0.21', '', None]:
            value = fixture()
            value['releases'][0]['version'] = version
            bad.append(value)
        value = fixture()
        value['releases'].append(copy.deepcopy(value['releases'][0]))
        bad.extend([value, {**fixture(), 'url': 'https://example.com'},
                    {**fixture(), 'releases': []}, {**fixture(), 'schema': True}])
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                configuration(value)

    def test_metadata_and_filenames_are_bounded(self):
        for info in [{'bytes': True, 'sha256': 'a' * 64}, {'bytes': 0, 'sha256': 'a' * 64},
                     {'bytes': 2 ** 53, 'sha256': 'a' * 64}, {'bytes': 1, 'sha256': 'bad'},
                     {'bytes': 1, 'sha256': 'a' * 64, 'url': 'https://example.com'}]:
            value = fixture()
            value['releases'][0]['assets']['LoliCode-Portable.zip'] = info
            with self.subTest(info=info), self.assertRaises(ValueError):
                configuration(value)
        value = fixture()
        value['releases'][0]['assets']['../other.exe'] = {'bytes': 1, 'sha256': 'a' * 64}
        with self.assertRaises(ValueError):
            configuration(value)


class LiveRouterTests(unittest.TestCase):
    def test_real_http_routes_healthy_r2_and_failed_github_same_version(self):
        config = configuration()
        cache = router.HealthCache(lambda asset: '/4.0.21/' in asset, config.assets)
        server = router.DownloadServer(('127.0.0.1', 0), router.handler_class(config, cache))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for version, base in [('4.0.20', router.GITHUB + '4.0.20/'),
                                  ('4.0.21', router.ORIGIN + '/lolicode/releases/4.0.21/')]:
                for name in [f'LoliCode-{version}-Windows-x64-Setup.exe', 'LoliCode-Portable.zip']:
                    for method in ['GET', 'HEAD']:
                        connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                        connection.request(method, f'/downloads/releases/{version}/{name}')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 302)
                        self.assertEqual(response.getheader('Location'), base + name)
                        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                        self.assertEqual(response.read(), b'')
                        connection.close()
            for method, path, status in [
                ('GET', '/downloads/releases/4.0.21/LoliCode-Portable.zip?x=1', 404),
                ('GET', '/downloads/releases/4.0.22/LoliCode-Portable.zip', 404),
                ('GET', '/downloads/releases/4.0.21/%2e%2e/other.exe', 404),
                ('POST', '/downloads/releases/4.0.21/LoliCode-Portable.zip', 405)]:
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                connection.request(method, path)
                response = connection.getresponse()
                self.assertEqual(response.status, status)
                self.assertIsNone(response.getheader('Location'))
                response.read()
                connection.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_unknown_asset_never_triggers_a_probe(self):
        seen = []
        config = configuration()
        cache = router.HealthCache(lambda asset: seen.append(asset), config.assets)
        self.assertFalse(cache.healthy('/unknown'))
        self.assertEqual(seen, [])


if __name__ == '__main__':
    unittest.main()
