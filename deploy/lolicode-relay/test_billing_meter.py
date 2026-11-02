"""Pure offline tests for administrator prices, money and Credit conversion."""
from copy import deepcopy
import unittest

import billing_meter as billing
from credit_meter import default_rate, usage_details


def config(mode='tokens', conversion=100, **changes):
    entry = ({'mode': 'tokens', 'prices': {'input': 2, 'output': 10, 'cacheRead': 0.5, 'cacheWrite': 3}}
             if mode == 'tokens' else {'mode': 'request', 'price': 0.02})
    entry.update(changes)
    return {'currency': 'USD', 'creditsPerUnit': conversion, 'modelPrices': {'model': entry}}


def snapshot(**kwargs):
    return billing.billing_snapshot({'billing_config': config(**kwargs), 'billing_revision': 7}, 'model')


def details(prompt=100, output=20, read=60, write=10):
    return usage_details({'usage': {'prompt_tokens': prompt, 'completion_tokens': output,
        'total_tokens': prompt + output, 'prompt_tokens_details': {
            'cached_tokens': read, 'cache_creation_tokens': write}}})


class BillingConfiguration(unittest.TestCase):
    def test_default_cny_conversion_has_no_automatic_model_prices(self):
        self.assertEqual(billing.default_billing_config(),
                         {'currency': 'CNY', 'creditsPerUnit': 100, 'modelPrices': {}})
        self.assertEqual(billing.normalize_billing_config(billing.default_billing_config()),
                         billing.default_billing_config())
        self.assertEqual(billing.billing_snapshot({}, 'new-model'), {'mode': 'credits', 'rate': default_rate()})

    def test_default_conversion_prices_ten_yuan_request_at_one_thousand_credits(self):
        configured = billing.default_billing_config()
        self.assertEqual(configured['modelPrices'], {})
        configured['modelPrices']['model'] = {'mode': 'request', 'price': 10}
        value = billing.billing_snapshot({'billing_config': configured}, 'model')
        self.assertEqual(billing.charge_units(None, value), 1000 * 1000000)
        self.assertEqual(billing.reservation_units(10, 20, value), 1000 * 1000000)
        self.assertEqual(billing.cost_details(None, value), {
            'currency': 'CNY', 'amount': '10', 'basis': 'request',
            'mode': 'request', 'creditsPerUnit': 100})
        self.assertEqual(billing.default_billing_config()['modelPrices'], {})

    def test_default_conversion_prices_one_million_ten_yuan_tokens_at_one_thousand_credits(self):
        configured = billing.default_billing_config()
        configured['modelPrices']['model'] = {'mode': 'tokens', 'prices': {
            'input': 10, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}
        value = billing.billing_snapshot({'billing_config': configured}, 'model')
        actual = {'total': 1000000, 'input': 1000000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        self.assertEqual(billing.charge_units(actual, value), 1000 * 1000000)
        self.assertEqual(billing.reservation_units(1000000, 0, value), 1000 * 1000000)
        money = billing.cost_details(actual, value)
        self.assertEqual((money['currency'], money['amount'], money['basis']), ('CNY', '10', 'usage'))

    def test_explicit_custom_conversion_is_preserved_and_does_not_populate_model_prices(self):
        empty_custom = {'currency': 'USD', 'creditsPerUnit': 37.5, 'modelPrices': {}}
        self.assertEqual(billing.normalize_billing_config(empty_custom), empty_custom)
        configured = deepcopy(empty_custom)
        configured['modelPrices']['model'] = {'mode': 'request', 'price': 10}
        value = billing.billing_snapshot({'billing_config': configured}, 'model')
        self.assertEqual(value['creditsPerUnit'], 37.5)
        self.assertEqual(billing.charge_units(None, value), 375 * 1000000)
        self.assertEqual(empty_custom['modelPrices'], {})
        self.assertEqual(billing.default_billing_config(),
                         {'currency': 'CNY', 'creditsPerUnit': 100, 'modelPrices': {}})

    def test_missing_conversion_or_any_price_is_rejected(self):
        values = [config(conversion=None), config(conversion=0),
                  {'currency': 'USD', 'creditsPerUnit': 1, 'modelPrices': {'model': {'mode': 'tokens'}}},
                  {'currency': 'USD', 'creditsPerUnit': 1, 'modelPrices': {'model': {'mode': 'request'}}}]
        for key in default_rate():
            value = config()
            del value['modelPrices']['model']['prices'][key]
            values.append(value)
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                billing.normalize_billing_config(value)

    def test_strict_fields_modes_model_ids_and_currency(self):
        values = [{}, {**config(), 'extra': 1}, {**config(), 'currency': 'EUR'},
                  {**config(), 'modelPrices': []}]
        for model in ('', ' spaced', 'contains space', 'a,b', 'a\x00b', 'a\x7fb', 'x' * 257):
            values.append({**config(), 'modelPrices': {model: {'mode': 'request', 'price': 0}}})
        for entry in ({'mode': 'unknown', 'price': 0}, {'mode': 'request', 'price': 0, 'extra': 1},
                      {'mode': 'tokens', 'prices': {**default_rate(), 'extra': 1}}):
            values.append({**config(), 'modelPrices': {'model': entry}})
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                billing.normalize_billing_config(value)
        self.assertEqual(billing.normalize_billing_config({**config(), 'currency': 'CNY'})['currency'], 'CNY')

    def test_decimal_number_validation_and_limits(self):
        invalid = (True, False, '1', -1, 1.0000001, 1000000.000001, float('nan'), float('inf'))
        for value in invalid:
            with self.subTest(conversion=value), self.assertRaises(ValueError):
                billing.normalize_billing_config(config(conversion=value))
            with self.subTest(price=value), self.assertRaises(ValueError):
                billing.normalize_billing_config(config(mode='request', price=value))
        value = config(conversion=0.000001, prices=dict.fromkeys(default_rate(), 0.000001))
        self.assertEqual(billing.normalize_billing_config(value), value)

    def test_derived_per_thousand_rate_has_explicit_maximum(self):
        value = config(conversion=1000000, prices=dict.fromkeys(default_rate(), 10))
        normalized = billing.normalize_billing_config(value)
        self.assertEqual(billing.derived_credit_rate(billing.billing_snapshot({'billing_config': normalized}, 'model')),
                         dict.fromkeys(default_rate(), 10000))
        for key in default_rate():
            too_large = deepcopy(value)
            too_large['modelPrices']['model']['prices'][key] = 10.000001
            with self.assertRaises(ValueError):
                billing.normalize_billing_config(too_large)

    def test_request_bills_must_fit_safe_integer_range(self):
        with self.assertRaises(ValueError):
            billing.normalize_billing_config(config(mode='request', conversion=1000000, price=1000000))
        allowed = config(mode='request', conversion=1, price=1000000)
        self.assertEqual(billing.charge_units(None, billing.billing_snapshot({'billing_config': allowed}, 'model')),
                         1000000000000)


class BillingTokenAmounts(unittest.TestCase):
    def test_cache_is_not_duplicated_and_cost_retains_currency(self):
        value = snapshot()
        actual = details()
        self.assertEqual(billing.charge_units(actual, value), 32000)
        self.assertEqual(billing.cost_details(actual, value), {
            'currency': 'USD', 'amount': '0.00032', 'basis': 'usage',
            'mode': 'tokens', 'creditsPerUnit': 100})
        self.assertEqual(billing.derived_credit_rate(value),
                         {'input': 0.2, 'output': 1, 'cacheRead': 0.05, 'cacheWrite': 0.3})

    def test_highest_rate_reservation_refunds_and_clips_output(self):
        value = snapshot()
        self.assertEqual(billing.reservation_units(100, 20, value), 120000)
        self.assertEqual(billing.output_capacity(120000, 100, 20, value), 20)
        self.assertEqual(billing.output_capacity(119999, 100, 20, value), 19)
        self.assertEqual(billing.output_capacity(100000, 100, 20, value), 0)
        self.assertEqual(billing.cost_details(None, value, reserved_tokens=(100, 20))['amount'], '0.0012')
        self.assertEqual(billing.cost_details(None, value, reserved_tokens=(100, 20))['basis'], 'reservation')

    def test_unknown_usage_is_most_expensive_and_stays_within_reservation(self):
        value = snapshot(prices={'input': 20, 'output': 1, 'cacheRead': 0, 'cacheWrite': 5})
        for actual in (usage_details({'usage': {'total_tokens': 120}}),
                       usage_details({'usage': {'prompt_tokens': 100, 'completion_tokens': 20,
                                               'prompt_tokens_details': {'cached_tokens': 101}}})):
            with self.subTest(actual=actual):
                self.assertLessEqual(billing.charge_units(actual, value), billing.reservation_units(100, 20, value))
        self.assertEqual(billing.cost_details(usage_details({'usage': {'total_tokens': 120}}), value)['amount'],
                         '0.0024')

    def test_exact_submicro_cost_and_single_final_rounding(self):
        value = snapshot(conversion=0.000001, prices=dict.fromkeys(default_rate(), 0.000001))
        actual = {'total': 4, 'input': 1, 'output': 1, 'cacheRead': 1, 'cacheWrite': 1}
        self.assertEqual(billing.cost_details(actual, value)['amount'], '0.000000000004')
        self.assertEqual(billing.charge_units(actual, value), 1)
        self.assertEqual(billing.derived_credit_rate(value)['input'], 1e-15)
        value = snapshot(conversion=1.234567, prices=dict.fromkeys(default_rate(), 2.345678))
        # Exact numerator = 2,345,678 * 1,234,567; no rounded derived rate is used.
        self.assertEqual(billing.charge_units({'total': 1, 'input': 1, 'output': 0,
            'cacheRead': 0, 'cacheWrite': 0}, value),
            (2345678 * 1234567 + 10**12 - 1) // 10**12)

    def test_admin_changes_cannot_mutate_existing_snapshot(self):
        current = config()
        policy = {'billing_config': current, 'billing_revision': 7}
        before = billing.billing_snapshot(policy, 'model')
        current['currency'] = 'CNY'
        current['creditsPerUnit'] = 200
        current['modelPrices']['model']['prices']['output'] = 100
        policy['billing_revision'] = 8
        after = billing.billing_snapshot(policy, 'model')
        self.assertEqual(before['revision'], 7)
        self.assertEqual(before['currency'], 'USD')
        self.assertEqual(after['currency'], 'CNY')
        self.assertEqual(billing.cost_details(details(), before)['currency'], 'USD')
        self.assertEqual(billing.cost_details(details(), after)['currency'], 'CNY')
        self.assertEqual(before['creditsPerUnit'], 100)
        self.assertEqual(before['prices']['output'], 10)
        self.assertEqual(billing.charge_units(details(), before), 32000)
        self.assertGreater(billing.charge_units(details(), after), 32000)

    def test_explicit_free_prices_and_invalid_usage(self):
        value = snapshot(prices=dict.fromkeys(default_rate(), 0))
        self.assertEqual(billing.charge_units(details(), value), 0)
        self.assertEqual(billing.reservation_units(100, 20, value), 0)
        self.assertEqual(billing.output_capacity(0, 100, 20, value), 20)
        self.assertEqual(billing.cost_details(details(), value)['amount'], '0')
        with self.assertRaises(ValueError):
            billing.charge_units(None, value)
        with self.assertRaises(ValueError):
            billing.cost_details(None, value)


class BillingRequestAndLegacy(unittest.TestCase):
    def test_fixed_request_price_ignores_token_count_and_missing_usage(self):
        value = snapshot(mode='request')
        for actual in (None, {}, details(), details(prompt=100000, output=1, read=0, write=0)):
            with self.subTest(actual=actual):
                self.assertEqual(billing.charge_units(actual, value), 2000000)
                self.assertEqual(billing.cost_details(actual, value), {
                    'currency': 'USD', 'amount': '0.02', 'basis': 'request',
                    'mode': 'request', 'creditsPerUnit': 100})
        self.assertEqual(billing.reservation_units(100, 20, value), 2000000)
        self.assertEqual(billing.output_capacity(2000000, 100, 20, value), 20)
        self.assertEqual(billing.output_capacity(1999999, 100, 20, value), 0)
        self.assertIsNone(billing.derived_credit_rate(value))

    def test_free_request_still_requires_a_valid_explicit_conversion(self):
        value = snapshot(mode='request', price=0)
        self.assertEqual(billing.charge_units(None, value), 0)
        self.assertEqual(billing.output_capacity(0, 100, 20, value), 20)
        self.assertEqual(billing.cost_details(None, value)['amount'], '0')
        with self.assertRaises(ValueError):
            billing.normalize_billing_config(config(mode='request', conversion=None, price=0))

    def test_legacy_rate_is_unchanged_and_has_no_invented_currency_cost(self):
        rate = {'input': 2, 'output': 10, 'cacheRead': 0.5, 'cacheWrite': 3}
        value = billing.billing_snapshot({'model_credit_rates': {'model': rate}}, 'model')
        self.assertEqual(value, {'mode': 'credits', 'rate': rate})
        self.assertEqual(billing.charge_units(details(), value), 320000)
        self.assertEqual(billing.reservation_units(100, 20, value), 1200000)
        self.assertEqual(billing.output_capacity(1200000, 100, 20, value), 20)
        self.assertEqual(billing.derived_credit_rate(value), rate)
        self.assertIsNone(billing.cost_details(details(), value))

    def test_invalid_bounds_and_snapshot_fail_closed(self):
        value = snapshot()
        for args in ((True, 1), (-1, 1), (1, -1), (1, 1.5)):
            with self.assertRaises(ValueError):
                billing.reservation_units(*args, value)
        with self.assertRaises(ValueError):
            billing.reservation_units(10**20, 1, value)
        for available in (-1, True, 1.5, 2**53):
            with self.assertRaises(ValueError):
                billing.output_capacity(available, 1, 1, value)
        with self.assertRaises(ValueError):
            billing.charge_units(details(), {**value, 'revision': True})

    def test_capacity_clips_an_oversized_candidate_into_safe_bill_range(self):
        value = snapshot()
        maximum = billing.MAX_BILL_UNITS
        capacity = billing.output_capacity(maximum, 0, 10**20, value)
        self.assertEqual(capacity, maximum // 1000)
        self.assertLessEqual(billing.reservation_units(0, capacity, value), maximum)
        with self.assertRaises(ValueError):
            billing.reservation_units(0, capacity + 1, value)


if __name__ == '__main__':
    unittest.main()
