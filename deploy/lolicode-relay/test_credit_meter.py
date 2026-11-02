"""Pure offline tests for integer Credit metering and conservative usage."""
import unittest

from credit_meter import (CREDIT_SCALE, RATE_SCALE, charge_units, credit_units, credit_value,
                          daily_credit_units, default_rate, model_rate,
                          normalize_rates, output_capacity, reservation_units,
                          usage_details)


class CreditNumbers(unittest.TestCase):
    def test_exact_roundtrip_and_smallest_unit(self):
        for number, units in ((0, 0), (1, CREDIT_SCALE), (0.000001, 1), (1.234567, 1234567),
                              (100000000, 100000000000000)):
            self.assertEqual(credit_units(number), units)
            self.assertEqual(credit_value(units), number)
        self.assertIs(type(credit_value(1000000)), int)

    def test_invalid_precision_types_bounds_and_nonfinite_values(self):
        for value in (True, False, '1', None, [], {}, -1, 0.0000001, 1.0000001,
                      100000001, float('nan'), float('inf'), -float('inf')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                credit_units(value)
        for value in (True, -1, 1.5):
            with self.assertRaises(ValueError):
                credit_value(value)

    def test_rate_schema_and_limits(self):
        rate = {'input': 0, 'output': 10000, 'cacheRead': 0.000001, 'cacheWrite': 1.234567}
        self.assertEqual(normalize_rates(rate), rate)
        for value in (True, float('nan'), float('inf'), -1, 10000.000001, 0.0000000001, '2'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_rates({**rate, 'input': value})
        for value in ({}, {**rate, 'extra': 1}, {key: value for key, value in rate.items() if key != 'input'}):
            with self.assertRaises(ValueError):
                normalize_rates(value)

    def test_rate_nine_decimal_places_do_not_change_balance_precision(self):
        self.assertEqual(RATE_SCALE, 1000000000)
        rate = {'input': 0.125123456, 'output': 0.000000001,
                'cacheRead': 0.0000001, 'cacheWrite': 1.123456789}
        self.assertEqual(normalize_rates(rate), rate)
        for invalid in (0.0000000001, 0.1251234561, 10000.000000001):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                normalize_rates({**rate, 'input': invalid})
        for amount in (0.0000001, 0.000000001, 0.125123456):
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                credit_units(amount)

    def test_policy_fallback_and_explicit_zero(self):
        policy = {'daily_tokens': 100000, 'global_daily_tokens': 100001}
        self.assertEqual(daily_credit_units(policy), 100 * CREDIT_SCALE)
        self.assertEqual(daily_credit_units(policy, True), 100001000)
        self.assertEqual(daily_credit_units({**policy, 'daily_credits': 0}), 0)
        self.assertEqual(daily_credit_units({**policy, 'daily_credits': 2.123456}), 2123456)
        self.assertIsNone(daily_credit_units({'daily_tokens': 1000}, True))
        self.assertIsNone(daily_credit_units({**policy, 'global_daily_credits': None}, True))
        for key, value in (('daily_credits', None), ('daily_credits', True), ('daily_tokens', False)):
            with self.assertRaises(ValueError):
                daily_credit_units({key: value})
        rate = {**default_rate(), 'output': 3}
        self.assertEqual(model_rate({'model_credit_rates': {'a': rate}}, 'a'), rate)
        self.assertEqual(model_rate({'model_credit_rates': {'a': rate}}, 'b'), default_rate())
        first = default_rate()
        first['input'] = 99
        self.assertEqual(default_rate()['input'], 1)


class CreditUsage(unittest.TestCase):
    rate = {'input': 2, 'output': 10, 'cacheRead': 0.5, 'cacheWrite': 3}

    def details(self, **usage):
        return usage_details({'usage': usage})

    def test_missing_cache_metadata_is_regular_input(self):
        details = self.details(prompt_tokens=100, completion_tokens=20, total_tokens=120)
        self.assertEqual(details, {'total': 120, 'input': 100, 'output': 20, 'cacheRead': 0, 'cacheWrite': 0})
        self.assertEqual(charge_units(details, self.rate), 400000)

    def test_cache_input_is_not_charged_twice_and_write_aliases_are_not_added(self):
        details = self.details(prompt_tokens=100, completion_tokens=20, total_tokens=120,
                               prompt_tokens_details={'cached_tokens': 60, 'cache_creation_tokens': 10})
        self.assertEqual(details['input'], 30)
        self.assertEqual(charge_units(details, self.rate), 320000)
        alias = self.details(prompt_tokens=100, completion_tokens=20,
                            prompt_tokens_details={'cached_tokens': 60, 'cache_write_tokens': 10,
                                                   'cache_creation_tokens': 10})
        self.assertEqual(alias, details)

    def test_total_only_and_incomplete_primary_counters_use_highest_rate(self):
        for usage in ({'total_tokens': 120}, {'total_tokens': 120, 'prompt_tokens': 100}):
            with self.subTest(usage=usage):
                details = self.details(**usage)
                self.assertIsNone(details['input'])
                self.assertIsNone(details['output'])
                self.assertEqual(charge_units(details, self.rate), 1200000)

    def test_extra_total_is_highest_rate_and_low_total_does_not_reduce_usage(self):
        details = self.details(prompt_tokens=100, completion_tokens=20, total_tokens=130)
        self.assertEqual(charge_units(details, self.rate), 500000)
        details = self.details(prompt_tokens=100, completion_tokens=20, total_tokens=1)
        self.assertEqual(details['total'], 120)
        self.assertEqual(charge_units(details, self.rate), 400000)

    def test_invalid_cache_categories_charge_unknown_input_at_highest_rate(self):
        for cache in ({'cached_tokens': 101}, {'cached_tokens': 60, 'cache_creation_tokens': 41},
                      {'cached_tokens': True}, {'cache_write_tokens': -1},
                      {'cache_creation_tokens': 10, 'cache_write_tokens': 20}, 'invalid'):
            with self.subTest(cache=cache):
                details = self.details(prompt_tokens=100, completion_tokens=20,
                                       prompt_tokens_details=cache)
                self.assertIsNone(details['input'])
                self.assertEqual(charge_units(details, self.rate), 1200000)

    def test_invalid_or_missing_usage_falls_back_to_reservation(self):
        for response in (None, {}, {'usage': None}, {'usage': []}, {'usage': {}},
                         {'usage': {'total_tokens': -1}}, {'usage': {'total_tokens': True}},
                         {'usage': {'prompt_tokens': 1}}, {'usage': {'total_tokens': 1.5}},
                         {'usage': {'total_tokens': 10000001}},
                         {'usage': {'total_tokens': 0, 'prompt_tokens': 10000001, 'completion_tokens': 0}},
                         {'usage': {'total_tokens': 120, 'prompt_tokens': False, 'completion_tokens': 20}},
                         {'usage': {'total_tokens': 10000001, 'prompt_tokens': 100,
                                    'completion_tokens': 20}},
                         {'usage': {'prompt_tokens': 10000000, 'completion_tokens': 1}}):
            with self.subTest(response=response):
                self.assertIsNone(usage_details(response))
        self.assertEqual(charge_units(self.details(total_tokens=0), self.rate), 0)

    def test_all_rates_zero_and_single_final_rounding(self):
        details = {'total': 4, 'input': 1, 'output': 1, 'cacheRead': 1, 'cacheWrite': 1}
        self.assertEqual(charge_units(details, dict.fromkeys(default_rate(), 0)), 0)
        self.assertEqual(charge_units(details, dict.fromkeys(default_rate(), 0.000001)), 1)
        self.assertEqual(charge_units({**details, 'total': 1001, 'input': 1001,
                                      'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                                     dict.fromkeys(default_rate(), 0.000001)), 2)

    def test_cache_write_can_be_most_expensive_unknown_category(self):
        rate = {**self.rate, 'cacheWrite': 50}
        self.assertEqual(charge_units(self.details(total_tokens=2), rate), 100000)


class CreditReservations(unittest.TestCase):
    def test_per_million_six_decimal_rate_keeps_exact_charge_and_reservation(self):
        # 125.123456 Credit / M is exactly 0.125123456 Credit / legacy K.
        rate = dict.fromkeys(default_rate(), 0.125123456)
        details = {'total': 1000, 'input': 1000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        self.assertEqual(charge_units(details, rate), 125124)
        self.assertEqual(reservation_units(600, 400, rate), 125124)
        self.assertEqual(output_capacity(125124, 600, 1000, rate), 400)
        self.assertEqual(output_capacity(125123, 600, 1000, rate), 399)
        # Summing categories precedes rounding; rounding each category would
        # overcharge this request, and rounding the rate to six places undercharges.
        details = {'total': 1000, 'input': 250, 'output': 250, 'cacheRead': 250, 'cacheWrite': 250}
        self.assertEqual(charge_units(details, rate), 125124)
        self.assertEqual(reservation_units(1, 0, dict.fromkeys(rate, 1)), 1000)

    def test_smallest_nano_rate_rounds_only_final_microcredit(self):
        rate = dict.fromkeys(default_rate(), 0.000000001)
        details = {'total': 1000000, 'input': 1000000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        self.assertEqual(charge_units(details, rate), 1)
        self.assertEqual(reservation_units(500000, 500000, rate), 1)
        self.assertEqual(output_capacity(1, 500000, 2000000, rate), 500000)
        details.update(total=1000001, input=1000001)
        self.assertEqual(charge_units(details, rate), 2)

    def test_conservative_input_and_output_capacity(self):
        rate = {'input': 2, 'output': 10, 'cacheRead': 0.5, 'cacheWrite': 3}
        self.assertEqual(reservation_units(100, 20, rate), 1200000)
        for available, expected in ((1200000, 20), (1199999, 19), (1000000, 0), (999999, 0), (0, 0)):
            with self.subTest(available=available):
                self.assertEqual(output_capacity(available, 100, 20, rate), expected)
        free_output = {**rate, 'output': 0}
        self.assertEqual(output_capacity(300300000, 100, 100000, free_output), 100000)
        self.assertEqual(output_capacity(300000, 100, 100000, free_output), 0)
        self.assertEqual(output_capacity(299999, 100, 100000, free_output), 0)
        self.assertEqual(output_capacity(0, 100, 100000, dict.fromkeys(rate, 0)), 100000)

    def test_unknown_usage_cannot_exceed_highest_rate_reservation(self):
        rates = [
            {'input': 20, 'output': 1, 'cacheRead': 0.1, 'cacheWrite': 3},
            {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 20},
            dict.fromkeys(default_rate(), 0.000001),
        ]
        responses = [
            {'usage': {'total_tokens': 100}},
            {'usage': {'prompt_tokens': 50, 'completion_tokens': 50,
                       'prompt_tokens_details': {'cached_tokens': 51}}},
            {'usage': {'prompt_tokens': 50, 'completion_tokens': 50,
                       'prompt_tokens_details': {'cached_tokens': 'invalid'}}},
        ]
        for rate in rates:
            with self.subTest(rate=rate):
                reserved = reservation_units(50, 50, rate)
                for response in responses:
                    self.assertLessEqual(charge_units(usage_details(response), rate), reserved)

    def test_microcredit_boundary_and_maximal_capacity(self):
        rate = dict.fromkeys(default_rate(), 0.000001)
        self.assertEqual(reservation_units(1, 1, rate), 1)
        self.assertEqual(output_capacity(1, 1, 5000, rate), 999)
        for available in range(10):
            output = output_capacity(available, 7, 10000, rate)
            if output:
                self.assertLessEqual(reservation_units(7, output, rate), available)
            if output < 10000:
                self.assertGreater(reservation_units(7, output + 1, rate), available)

    def test_invalid_reservation_arguments(self):
        for args in ((True, 1), (-1, 1), (1, True), (1, -1), (1.5, 1)):
            with self.assertRaises(ValueError):
                reservation_units(*args, default_rate())
        for value in (True, -1, 1.5):
            with self.assertRaises(ValueError):
                output_capacity(value, 1, 1, default_rate())


if __name__ == '__main__':
    unittest.main()
