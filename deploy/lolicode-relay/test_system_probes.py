"""System connectivity probes cannot consume user quotas or bypass capacity."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

from bridge import Ledger, Rejected
from test_bridge import POLICY


class ProbeCapacity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = Ledger(Path(self.temp.name) / 'ledger.sqlite3')
        self.policy = {**POLICY, 'max_concurrent_global': 1, 'global_requests_per_minute': 100}
        self.now = datetime(2026, 10, 30, 8, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.temp.cleanup()

    def test_probe_blocks_inference_but_does_not_spend_daily_allowance(self):
        before = self.ledger.summary('42', self.policy, self.now)
        probe = self.ledger.acquire_probe(self.policy, self.now)
        with self.assertRaises(Rejected) as caught:
            self.ledger.reserve('42', 'mock-model', 10, 10, self.policy, self.now)
        self.assertEqual(caught.exception.code, 'service_busy')
        self.assertEqual(self.ledger.summary('42', self.policy, self.now), before)
        self.ledger.finish_probe(probe)
        request, _ = self.ledger.reserve('42', 'mock-model', 10, 10, self.policy, self.now)
        self.ledger.finish(request, 5)
        self.assertEqual(self.ledger.summary('42', self.policy, self.now)['requestsUsed'], 1)

    def test_active_user_request_skips_probe_and_parallel_probes_are_atomic(self):
        request, _ = self.ledger.reserve('42', 'mock-model', 10, 10, self.policy, self.now)
        with self.assertRaises(Rejected):
            self.ledger.acquire_probe(self.policy, self.now)
        self.ledger.finish(request, release=True)
        def attempt(_):
            try:
                return self.ledger.acquire_probe(self.policy, self.now)
            except Rejected:
                return None
        with ThreadPoolExecutor(max_workers=10) as workers:
            probes = list(workers.map(attempt, range(20)))
        self.assertEqual(sum(item is not None for item in probes), 1)

    def test_uncertain_probe_keeps_bounded_lease_through_restart(self):
        probe = self.ledger.acquire_probe(self.policy, self.now)
        self.ledger.finish_probe(probe, uncertain=True)
        self.ledger = Ledger(self.ledger.path)
        self.ledger.recover()
        with self.assertRaises(Rejected):
            self.ledger.acquire_probe(self.policy, self.now + timedelta(seconds=359))
        self.assertTrue(self.ledger.acquire_probe(self.policy, self.now + timedelta(seconds=361)))

    def test_probe_and_inference_share_requests_per_minute(self):
        self.policy['global_requests_per_minute'] = 1
        probe = self.ledger.acquire_probe(self.policy, self.now)
        self.ledger.finish_probe(probe)
        with self.assertRaises(Rejected) as caught:
            self.ledger.reserve('42', 'mock-model', 10, 10, self.policy, self.now)
        self.assertEqual(caught.exception.code, 'service_rate_limited')
        self.assertTrue(self.ledger.acquire_probe(self.policy, self.now + timedelta(seconds=61)))


if __name__ == '__main__':
    unittest.main()
