"""Credit-only contracts, atomic ledger versions and historical compatibility."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from billing_meter import billing_snapshot, charge_units as bill_charge_units
from bridge import Ledger, Rejected, calendar, public_models
from credit_meter import default_rate, usage_details
from quota_snapshot import credit_balance, credit_pricing, credit_projection


def policy():
    return {'daily_requests': None, 'global_daily_requests': None,
            'daily_tokens': 100000, 'daily_credits': 100,
            'max_output_tokens': 4096, 'max_request_bytes': 131072,
            'max_concurrent_per_account': 100, 'billing_revision': 7,
            'models': [{'id': 'model', 'name': 'Model', 'contextLimit': 65536, 'outputLimit': 4096}],
            'model_credit_rates': {'model': default_rate()}}


class QuotaContract(unittest.TestCase):
    def test_canonical_balance_conserves_microcredit_and_projects_identical_flat_fields(self):
        balance = credit_balance(100000000, 12345678, 7654322, pricing_revision=7, ledger_revision=9)
        self.assertEqual(balance, {'unit': 'Credit', 'limit': 100, 'used': 12.345678,
            'reserved': 7.654322, 'remaining': 80, 'pricingRevision': 7, 'ledgerRevision': 9})
        self.assertEqual(sum(Decimal(str(balance[key])) for key in ('used', 'reserved', 'remaining')),
                         Decimal(str(balance['limit'])))
        projected = credit_projection(balance)
        self.assertEqual(projected['creditBalance'], balance)
        for old, current in (('creditUnit', 'unit'), ('creditLimit', 'limit'), ('creditsUsed', 'used'),
                             ('creditsReserved', 'reserved'), ('creditsRemaining', 'remaining')):
            self.assertEqual(projected[old], balance[current])
        projected['creditBalance']['remaining'] = 0
        self.assertEqual(balance['remaining'], 80)

    def test_lowered_limit_does_not_rewrite_used_or_reserved_amounts(self):
        self.assertEqual(credit_balance(1000, 1200, 100)['remaining'], 0)
        self.assertEqual(credit_balance(1000, 1200, 100)['used'], 0.0012)
        for kwargs in ({'pricing_revision': True}, {'ledger_revision': -1}, {'ledger_revision': 2**53}):
            with self.assertRaises(ValueError):
                credit_balance(0, 0, 0, **kwargs)

    def test_public_credit_per_million_preserves_nine_place_legacy_rates(self):
        current = policy()
        current['model_credit_rates']['model'] = {
            'input': 0.125123456, 'output': 0.04667, 'cacheRead': 0.00383, 'cacheWrite': 0.01333}
        pricing = public_models(current)[0]['creditPricing']
        self.assertEqual(pricing, {'unit': 'Credit', 'mode': 'tokens', 'perTokens': 1000000,
            'prices': {'input': 125.123456, 'output': 46.67, 'cacheRead': 3.83, 'cacheWrite': 13.33}})
        self.assertEqual(public_models(current)[0]['creditRate']['input'], 0.125123456)
        self.assertNotIn('currency', json.dumps(pricing))
        self.assertNotIn('creditsPerUnit', json.dumps(pricing))

    def test_old_currency_snapshots_project_equivalent_credit_prices_without_changing_bills(self):
        current = policy()
        current['billing_config'] = {'currency': 'CNY', 'creditsPerUnit': 100, 'modelPrices': {
            'model': {'mode': 'tokens', 'prices': {'input': 2.2, 'output': 8.8,
                                                 'cacheRead': 0.044, 'cacheWrite': 2.2}}}}
        snapshot = billing_snapshot(current, 'model')
        before = deepcopy(snapshot)
        pricing = credit_pricing(snapshot)
        self.assertEqual(pricing['prices'], {'input': 220, 'output': 880, 'cacheRead': 4.4, 'cacheWrite': 220})
        details = usage_details({'usage': {'prompt_tokens': 1000, 'completion_tokens': 1000}})
        self.assertEqual(bill_charge_units(details, snapshot), 1100000)
        self.assertEqual(snapshot, before)
        current['billing_config']['modelPrices']['model'] = {'mode': 'request', 'price': 0.02}
        pricing = credit_pricing(billing_snapshot(current, 'model'))
        self.assertEqual(pricing, {'unit': 'Credit', 'mode': 'request', 'creditsPerRequest': 2})


class LedgerRevision(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ledger.sqlite3'
        self.policy = policy()
        self.ledger = Ledger(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def balance(self):
        return self.ledger.summary('42', self.policy)['creditBalance']

    def test_reserve_finish_and_refund_increment_once_and_flat_projection_agrees(self):
        self.assertEqual(self.balance()['ledgerRevision'], 0)
        request, _ = self.ledger.reserve('42', 'model', 10, 20, self.policy)
        self.assertEqual(self.balance(), {'unit': 'Credit', 'limit': 100, 'used': 0,
            'reserved': 0.03, 'remaining': 99.97, 'pricingRevision': 7, 'ledgerRevision': 1})
        self.ledger.finish(request, 12)
        self.assertEqual((self.balance()['used'], self.balance()['reserved'], self.balance()['ledgerRevision']),
                         (0.012, 0, 2))
        self.ledger.finish(request, 1000)
        self.ledger.finish(request, release=True)
        self.assertEqual(self.balance()['ledgerRevision'], 2)
        refunded, _ = self.ledger.reserve('42', 'model', 5, 5, self.policy)
        self.ledger.finish(refunded, release=True)
        self.assertEqual((self.balance()['used'], self.balance()['ledgerRevision']), (0.012, 4))
        summary = self.ledger.summary('42', self.policy)
        self.assertEqual(summary['creditsRemaining'], summary['creditBalance']['remaining'])
        self.assertEqual(summary['creditsUsed'], summary['creditBalance']['used'])

    def test_recover_advances_once_only_when_pending_state_changes(self):
        for _ in range(2):
            self.ledger.reserve('42', 'model', 10, 20, self.policy)
        self.assertEqual(self.balance()['ledgerRevision'], 2)
        self.ledger = Ledger(self.path)
        self.assertEqual(self.balance()['ledgerRevision'], 2)
        self.ledger.recover()
        self.assertEqual((self.balance()['used'], self.balance()['reserved'], self.balance()['ledgerRevision']),
                         (0.06, 0, 3))
        self.ledger.recover()
        self.assertEqual(self.balance()['ledgerRevision'], 3)

    def test_rejected_reservation_account_updates_and_probes_do_not_advance_credit_version(self):
        self.ledger.account({'id': '42', 'username': 'member', 'displayName': 'Member'})
        lease = self.ledger.acquire_probe(self.policy)
        self.ledger.finish_probe(lease)
        self.assertEqual(self.balance()['ledgerRevision'], 0)
        self.policy['daily_credits'] = 0
        with self.assertRaises(Rejected):
            self.ledger.reserve('42', 'model', 1, 1, self.policy)
        self.assertEqual(self.balance()['ledgerRevision'], 0)

    def test_revision_failure_rolls_back_request_insert_and_settlement_amounts(self):
        with patch.object(self.ledger, '_advance_revision', side_effect=ValueError('test rollback')):
            with self.assertRaises(ValueError):
                self.ledger.reserve('42', 'model', 10, 20, self.policy)
        self.assertEqual((self.balance()['reserved'], self.balance()['ledgerRevision']), (0, 0))
        request, _ = self.ledger.reserve('42', 'model', 10, 20, self.policy)
        with patch.object(self.ledger, '_advance_revision', side_effect=ValueError('test rollback')):
            with self.assertRaises(ValueError):
                self.ledger.finish(request, 12)
        self.assertEqual((self.balance()['used'], self.balance()['reserved'], self.balance()['ledgerRevision']),
                         (0, 0.03, 1))
        self.ledger.finish(request, 12)
        self.assertEqual(self.balance()['ledgerRevision'], 2)

    def test_parallel_reserves_and_duplicate_finishes_have_no_lost_or_duplicate_versions(self):
        def reserve(_):
            return self.ledger.reserve('42', 'model', 1, 1, self.policy)[0]
        with ThreadPoolExecutor(max_workers=8) as workers:
            requests = list(workers.map(reserve, range(20)))
        self.assertEqual(self.balance()['ledgerRevision'], 20)
        with ThreadPoolExecutor(max_workers=8) as workers:
            list(workers.map(lambda request: self.ledger.finish(request, 2), requests + requests))
        self.assertEqual((self.balance()['used'], self.balance()['ledgerRevision']), (0.04, 40))

    def test_read_transaction_keeps_its_balance_and_revision_consistent_during_concurrent_write(self):
        with self.ledger.connect() as db:
            db.execute('BEGIN')
            before = self.ledger.summary('42', self.policy, db=db)['creditBalance']
            self.ledger.reserve('42', 'model', 10, 20, self.policy)
            self.assertEqual(self.ledger.summary('42', self.policy, db=db)['creditBalance'], before)
        self.assertEqual((self.balance()['reserved'], self.balance()['ledgerRevision']), (0.03, 1))

    def test_pricing_revision_changes_without_revaluing_current_credit_balance(self):
        request, _ = self.ledger.reserve('42', 'model', 10, 20, self.policy)
        self.ledger.finish(request, 12)
        before = self.balance()
        self.policy['billing_revision'] = 8
        self.policy['model_credit_rates']['model'] = dict.fromkeys(default_rate(), 5)
        after = self.balance()
        self.assertEqual(after, {**before, 'pricingRevision': 8})

    def test_additive_clock_migration_preserves_existing_request_amounts_and_billing_snapshots(self):
        frozen = {'mode': 'request', 'currency': 'USD', 'creditsPerUnit': 100,
                  'price': 0.02, 'revision': 3}
        with self.ledger.connect() as db:
            db.execute('''INSERT INTO requests(id,forum_id,day,reserved,charged,state,model,created_at,
                credit_reserved,credit_charged,credit_rate,billing_snapshot,cost_details)
                VALUES('old','42',?,200,120,'charged','model',1,2000000,2000000,?,?,?)''',
                (calendar()[0], json.dumps(default_rate()), json.dumps(frozen),
                 json.dumps({'currency': 'USD', 'amount': '0.02', 'basis': 'request'})))
            before = tuple(db.execute("SELECT * FROM requests WHERE id='old'").fetchone())
            db.execute('DROP TABLE quota_ledger_revision')
        self.ledger = Ledger(self.path)
        self.ledger = Ledger(self.path)
        with self.ledger.connect() as db:
            after = tuple(db.execute("SELECT * FROM requests WHERE id='old'").fetchone())
        self.assertEqual(after, before)
        self.assertEqual((self.balance()['used'], self.balance()['ledgerRevision']), (2, 0))


if __name__ == '__main__':
    unittest.main()
