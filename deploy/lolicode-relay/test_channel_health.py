"""Offline coverage for channel selection, safety, leases and crash-safe cadence."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import channel_health as health
from bridge import Rejected


def channel(identity=1, **overrides):
    return {'id': identity, 'type': 8, 'status': 1, 'group': 'default',
            'models': 'public-a,public-b,private', 'test_model': 'public-b',
            'base_url': 'https://upstream.invalid/v1/chat/completions', **overrides}


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 30, 1, 0, tzinfo=timezone.utc)
        self.monotonic = 0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.advance(seconds)

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)
        self.monotonic += seconds


class FakeDashboard:
    def __init__(self, rows):
        self.rows = rows
        self.logged_in = self.logged_out = False
        self.token = 'private-admin-token'
        self.paths = []
        self.metadata_hook = None

    def login(self):
        self.logged_in = True

    def logout(self):
        self.logged_out = True

    def request(self, path):
        self.paths.append(path)
        if path.startswith('/api/channel/?'):
            page = int(path.split('p=')[1].split('&')[0])
            return {'items': deepcopy(self.rows[(page - 1) * 50:page * 50]), 'total': len(self.rows)}
        identity = int(path.rsplit('/', 1)[1])
        if self.metadata_hook:
            self.metadata_hook(identity)
        return deepcopy(next(row for row in self.rows if row['id'] == identity))


class FakeLedger:
    def __init__(self):
        self.acquired = []
        self.finished = []
        self.busy = False

    def acquire_probe(self, policy):
        if self.busy:
            raise Rejected(429, 'service_busy', 'untrusted-private-key')
        identity = 'probe-' + str(len(self.acquired))
        self.acquired.append((identity, deepcopy(policy)))
        return identity

    def finish_probe(self, identity, uncertain=False):
        self.finished.append((identity, uncertain))


class HealthWorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state_directory = self.root / 'bridge-state'
        self.state_directory.mkdir()
        self.policy = {
            'daily_requests': 20, 'daily_tokens': 100000, 'max_output_tokens': 4096,
            'max_request_bytes': 131072, 'max_concurrent_per_account': 2,
            'models': [{'id': 'public-a', 'protocol': 'openai_chat'},
                       {'id': 'public-b', 'protocol': 'openai_chat'}],
        }
        self.save_policy()
        self.clock = Clock()
        self.client = FakeDashboard([channel()])
        self.ledger = FakeLedger()
        self.calls = []

    def save_policy(self):
        (self.root / 'bridge-policy.json').write_text(json.dumps(self.policy), encoding='utf8')

    def probe(self, client, identity, model, *, timeout):
        self.calls.append((identity, model, self.clock.monotonic, timeout))
        self.clock.advance(0.25)
        return {'status': 'healthy', 'httpStatus': 200, 'reason': health.REASONS['healthy'], 'uncertain': False}

    def run_worker(self, **options):
        return health.run_checks(self.root, client_factory=lambda: self.client,
            ledger_factory=lambda _path: self.ledger, test_fn=self.probe,
            sleep=self.clock.sleep, monotonic=lambda: self.clock.monotonic,
            clock=lambda: self.clock.now, **options)

    def read(self):
        return json.loads((self.state_directory / 'channel-health.json').read_text(encoding='utf8'))

    def test_eligible_selection_prefers_only_an_explicitly_public_model(self):
        self.assertEqual(health.selected_model(channel(), {'public-a', 'public-b'}), 'public-b')
        self.assertEqual(health.selected_model(channel(test_model='private'), {'public-a'}), 'public-a')
        for overrides in ({'status': 2}, {'group': 'private'}, {'type': 2}, {'models': 'private'},
                          {'base_url': 'https://upstream.invalid/unrelated'}):
            self.assertIsNone(health.selected_model(channel(**overrides), {'public-a'}))
        for kind in (1, 14, 24):
            self.assertEqual(health.selected_model(channel(type=kind), {'public-a'}), 'public-a')

    def test_healthy_round_is_serial_throttled_and_uses_shared_probe_leases(self):
        self.client.rows.append(channel(2))
        result = self.run_worker()
        self.assertEqual(result['tested'], 2)
        self.assertEqual([row[1] for row in self.calls], ['public-b', 'public-b'])
        self.assertGreaterEqual(self.calls[1][2] - self.calls[0][2], 11.25)
        self.assertEqual([row[3] for row in self.calls], [90, 90])
        self.assertEqual(self.ledger.finished, [('probe-0', False), ('probe-1', False)])
        self.assertTrue(self.client.logged_out)
        stored = self.read()
        self.assertEqual(stored['history'][0]['healthy'], 2)
        self.assertNotIn('private-admin-token', json.dumps(stored))
        self.assertFalse((self.state_directory / 'bridge.sqlite3').exists())

    def test_duplicate_hour_does_not_resend_a_probe(self):
        self.run_worker()
        self.run_worker()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.ledger.acquired), 1)
        self.clock.advance(3600)
        self.run_worker()
        self.assertEqual(len(self.calls), 2)

    def test_attempt_marker_survives_a_killed_worker_and_logout_still_runs(self):
        def killed(*_args, **_kwargs):
            raise KeyboardInterrupt()
        with patch.object(self, 'probe', killed):
            with self.assertRaises(KeyboardInterrupt):
                self.run_worker()
        self.assertTrue(self.client.logged_out)
        self.assertEqual(self.ledger.finished, [('probe-0', True)])
        self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['pending'])
        self.run_worker()
        self.assertEqual(self.calls, [])

    def test_busy_service_skips_without_sending_or_changing_a_user_ledger(self):
        self.ledger.busy = True
        self.run_worker()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['busy'])
        self.assertEqual(self.read()['attempts'], [])
        self.assertNotIn('untrusted-private-key', json.dumps(self.read()))

    def test_publication_and_channel_status_are_rechecked_before_each_probe(self):
        self.client.metadata_hook = lambda identity: self.client.rows[0].update(status=2)
        self.run_worker()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read()['results'][0]['status'], 'skipped')

    def test_expired_or_unpublished_service_sends_nothing_and_does_not_log_in(self):
        self.policy['available_until'] = '2026-10-29T00:00:00+00:00'
        self.save_policy()
        self.assertEqual(self.run_worker()['tested'], 0)
        self.assertFalse(self.client.logged_in)
        self.assertEqual(self.read()['lastRunAt'], health.timestamp(self.clock.now))
        self.assertEqual(self.read()['nextRunAt'], '2026-10-30T02:00:00+00:00')
        self.policy.pop('available_until')
        self.policy['models'] = []
        self.save_policy()
        self.assertEqual(self.run_worker()['tested'], 0)

    def test_inactive_round_keeps_last_channel_details_but_marks_the_test_skipped(self):
        self.run_worker()
        self.policy['models'] = []
        self.save_policy()
        self.clock.advance(3600)
        self.run_worker()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.read()['results'][0]['status'], 'skipped')
        self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['inactive'])
        self.assertEqual(self.read()['lastRunAt'], health.timestamp(self.clock.now))

    def test_nonempty_parameter_overrides_are_never_used_for_automatic_probes(self):
        for override in ('{"max_tokens":100000}', '{"messages":[]}', 'invalid'):
            with self.subTest(override=override):
                self.client.rows[0]['param_override'] = override
                self.run_worker()
                self.assertEqual(self.calls, [])
                self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['overrides'])
        self.client.rows[0]['param_override'] = '{}'
        self.run_worker()
        self.assertEqual(len(self.calls), 1)

    def test_publication_can_expire_while_the_worker_is_waiting(self):
        self.policy['available_until'] = '2026-10-30T01:00:05+00:00'
        self.save_policy()
        self.client.rows.append(channel(2))
        self.run_worker()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.read()['results'][1]['status'], 'skipped')

    def test_dry_run_has_no_probe_lease_or_state_writes(self):
        result = self.run_worker(dry_run=True)
        self.assertEqual(result['candidates'], [{'channelId': 1, 'model': 'public-b'}])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.ledger.acquired, [])
        self.assertFalse((self.state_directory / 'channel-health.json').exists())
        self.assertFalse((self.state_directory / 'channel-health.lock').exists())
        self.assertTrue(self.client.logged_out)

    def test_failure_counters_and_timeout_leases_are_retained_until_a_success(self):
        def timeout(*_args, **_kwargs):
            return {'status': 'timeout', 'httpStatus': None, 'reason': health.REASONS['timeout'], 'uncertain': True}
        with patch.object(self, 'probe', timeout):
            self.run_worker()
            self.clock.advance(3600)
            self.run_worker()
        self.assertEqual(self.read()['results'][0]['consecutiveFailures'], 2)
        self.assertEqual(self.ledger.finished, [('probe-0', True), ('probe-1', True)])
        self.clock.advance(3600)
        self.run_worker()
        self.assertEqual(self.read()['results'][0]['consecutiveFailures'], 0)

    def test_metadata_failures_are_fixed_text_and_dashboard_always_logs_out(self):
        self.client.metadata_hook = lambda _identity: (_ for _ in ()).throw(RuntimeError('private-upstream-key'))
        self.run_worker()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['metadata'])
        self.assertNotIn('private-upstream-key', json.dumps(self.read()))
        self.assertTrue(self.client.logged_out)

    def test_invalid_native_results_cannot_inject_private_text_into_the_state(self):
        def unsafe(*_args, **_kwargs):
            return {'status': 'failed', 'reason': 'private-upstream-key', 'uncertain': False}
        with patch.object(self, 'probe', unsafe):
            self.run_worker()
        self.assertNotIn('private-upstream-key', json.dumps(self.read()))
        self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['network'])

    def test_budget_is_checked_again_after_slow_metadata(self):
        self.client.metadata_hook = lambda _identity: self.clock.advance(2990)
        self.run_worker()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.read()['results'][0]['reason'], health.REASONS['budget'])

    def test_configuration_changes_and_old_results_are_visible_as_stale(self):
        self.run_worker()
        view = health.health_view(self.state_directory, self.client.rows, now=self.clock.now,
                                  public_model_ids={'public-a', 'public-b'})
        self.assertEqual(view['results'][0]['status'], 'healthy')
        self.client.rows[0]['param_override'] = '{"temperature":0}'
        view = health.health_view(self.state_directory, self.client.rows, now=self.clock.now,
                                  public_model_ids={'public-a', 'public-b'})
        self.assertEqual(view['results'][0]['status'], 'stale')
        self.client.rows[0].pop('param_override')
        self.clock.advance(7201)
        view = health.health_view(self.state_directory, self.client.rows, now=self.clock.now)
        self.assertEqual(view['results'][0]['reason'], health.REASONS['stale'])

    def test_read_only_projection_reports_unknown_and_strips_untrusted_fields(self):
        view = health.health_view(self.state_directory, [channel()], now=self.clock.now)
        self.assertEqual(view['results'][0]['status'], 'unknown')
        self.assertFalse((self.state_directory / 'channel-health.json').exists())
        self.run_worker()
        stored = self.read()
        stored['results'][0].update(key='private-key', reason='private-error')
        stored['history'][0].update(key='private-key')
        health.write_state(self.state_directory, stored)
        view = health.health_view(self.state_directory, self.client.rows, now=self.clock.now)
        self.assertNotIn('private-', json.dumps(view))
        self.assertNotIn('attempts', view)
        self.assertEqual(view['results'][0]['reason'], health.REASONS['healthy'])

    def test_history_is_limited_by_seven_days_and_168_rounds(self):
        stored = health.empty_state()
        stored['history'] = [{'runAt': health.timestamp(self.clock.now - timedelta(hours=index)), 'healthy': 1}
                             for index in range(200, 0, -1)]
        health.write_state(self.state_directory, stored)
        self.run_worker()
        history = self.read()['history']
        self.assertLessEqual(len(history), 168)
        self.assertTrue(all(health.parse_time(row['runAt']) >= self.clock.now - timedelta(days=7) for row in history))

    def test_configuration_fingerprint_ignores_test_time_and_never_contains_secrets(self):
        initial = channel(key='private-key', header_override='private-header')
        fingerprint = health.channel_fingerprint(initial)
        self.assertEqual(health.channel_fingerprint({**initial, 'test_time': 123, 'response_time': 2}), fingerprint)
        self.assertNotEqual(health.channel_fingerprint({**initial, 'key': 'new-private-key'}), fingerprint)
        self.assertRegex(fingerprint, '^[0-9a-f]{64}$')

    def test_lock_refuses_an_overlapping_worker(self):
        with health.round_lock(self.state_directory):
            with self.assertRaises(health.AlreadyRunning):
                with health.round_lock(self.state_directory):
                    self.fail('A second lock must not succeed')

    def test_invalid_catalog_logs_out_and_never_starts_probes(self):
        self.client.rows = [channel(index + 1) for index in range(257)]
        with self.assertRaises(ValueError):
            self.run_worker()
        self.assertTrue(self.client.logged_out)
        self.assertEqual(self.calls, [])

    def test_native_pagination_starts_at_one_and_reads_all_256_unique_channels(self):
        self.client.rows = [channel(index + 1) for index in range(256)]
        rows = health.list_channels(self.client)
        self.assertEqual(len(rows), 256)
        self.assertEqual(self.client.paths[0], '/api/channel/?p=1&page_size=50')
        self.assertEqual(self.client.paths[-1], '/api/channel/?p=6&page_size=50')
        self.assertEqual(len({row['id'] for row in rows}), 256)

    def test_failed_atomic_state_replacement_keeps_previous_bytes_and_cleans_the_temporary(self):
        self.run_worker()
        path = self.state_directory / 'channel-health.json'
        previous = path.read_bytes()
        with patch.object(health.os, 'replace', side_effect=OSError('test write failure')):
            with self.assertRaises(OSError):
                health.write_state(self.state_directory, health.empty_state())
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(list(self.state_directory.glob('.channel-health-*')), [])


class NativeProbeTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeDashboard([])
        self.response_status = 200
        self.raw = b'{"success": false, "message": "private-upstream-key"}'
        self.error = None
        self.requests = []
        self.session_options = {}

    def fake_session(self, **options):
        self.session_options = options
        case = self
        class Response:
            status = case.response_status
            async def __aenter__(inner):
                return inner
            async def __aexit__(inner, *_args):
                pass
            @property
            def content(inner):
                return inner
            async def iter_chunked(inner, _size):
                yield case.raw
        class Session:
            async def __aenter__(inner):
                return inner
            async def __aexit__(inner, *_args):
                pass
            def get(inner, url, **kwargs):
                case.requests.append((url, kwargs))
                if case.error:
                    raise case.error
                return Response()
        return Session()

    def test_explicit_small_nonstreaming_openai_endpoint_and_fixed_result(self):
        with patch.object(health.aiohttp, 'ClientSession', self.fake_session):
            result = health.channel_test(self.client, 7, 'public/a')
        path, options = self.requests[0]
        self.assertIn('/api/channel/test/7?', path)
        self.assertIn('model=public%2Fa', path)
        self.assertIn('endpoint_type=openai', path)
        self.assertIn('stream=false', path)
        self.assertFalse(options['allow_redirects'])
        self.assertFalse(self.session_options['trust_env'])
        self.assertEqual(self.session_options['timeout'].total, 90)
        self.assertEqual(self.session_options['headers']['Authorization'], 'Bearer private-admin-token')
        self.assertEqual(result, {'status': 'failed', 'httpStatus': 200,
            'reason': health.REASONS['failed'], 'uncertain': False})

    def test_native_http_errors_are_sanitized(self):
        self.response_status = 503
        self.raw = b'private-key'
        with patch.object(health.aiohttp, 'ClientSession', self.fake_session):
            result = health.channel_test(self.client, 1, 'public-a')
        self.assertEqual(result['httpStatus'], 503)
        self.assertNotIn('private-key', json.dumps(result))
        self.assertFalse(result['uncertain'])

    def test_timeout_is_uncertain_and_does_not_release_its_capacity_lease(self):
        self.error = TimeoutError('private-key')
        with patch.object(health.aiohttp, 'ClientSession', self.fake_session):
            result = health.channel_test(self.client, 1, 'public-a')
        self.assertEqual(result['status'], 'timeout')
        self.assertTrue(result['uncertain'])
        self.assertNotIn('private-key', json.dumps(result))

    def test_malformed_response_is_uncertain_and_never_includes_raw_content(self):
        self.raw = b'private-upstream-key'
        with patch.object(health.aiohttp, 'ClientSession', self.fake_session):
            result = health.channel_test(self.client, 1, 'public-a')
        self.assertEqual(result['reason'], health.REASONS['invalid_response'])
        self.assertTrue(result['uncertain'])
        self.assertNotIn('private-upstream-key', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
