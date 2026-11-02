"""Exact Credit accounting for normalized Chat Completions usage.

Compatibility rates are Credit per 1,000 tokens with nine decimal places, so
displayed rates per million tokens retain six places. Stored balances remain
integer microCredit; rounding happens once after combining billable categories.
"""
from decimal import Decimal, InvalidOperation
import math


CREDIT_SCALE = 1_000_000
RATE_SCALE = 1_000_000_000
RATE_DIVISOR = RATE_SCALE * 1000 // CREDIT_SCALE
RATE_FIELDS = frozenset(('input', 'output', 'cacheRead', 'cacheWrite'))
MAX_USAGE_TOKENS = 10_000_000


def _decimal(value, maximum, scale=CREDIT_SCALE):
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise ValueError('invalid_credit_number')
    try:
        number = Decimal(str(value))
        scaled = number * scale
        if number < 0 or number > Decimal(str(maximum)) or scaled != scaled.to_integral_value():
            raise ValueError('invalid_credit_number')
    except (InvalidOperation, OverflowError):
        raise ValueError('invalid_credit_number') from None
    return number


def default_rate():
    return {'input': 1, 'output': 1, 'cacheRead': 1, 'cacheWrite': 1}


def normalize_rates(value):
    if not isinstance(value, dict) or set(value) != RATE_FIELDS:
        raise ValueError('invalid_credit_rates')
    result = {}
    for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
        number = _decimal(value[key], 10_000, scale=RATE_SCALE)
        result[key] = int(number) if number == number.to_integral_value() else float(number)
    return result


def credit_units(value, maximum=100_000_000):
    return int(_decimal(value, maximum) * CREDIT_SCALE)


def credit_value(units):
    if type(units) is not int or units < 0:
        raise ValueError('invalid_credit_units')
    whole, fraction = divmod(units, CREDIT_SCALE)
    return whole if fraction == 0 else float(Decimal(units) / CREDIT_SCALE)


def model_rate(policy, model_id):
    rates = policy.get('model_credit_rates', {})
    if not isinstance(rates, dict):
        raise ValueError('invalid_model_credit_rates')
    return normalize_rates(rates[model_id]) if model_id in rates else default_rate()


def daily_credit_units(policy, global_pool=False):
    field = 'global_daily_credits' if global_pool else 'daily_credits'
    if field in policy:
        if global_pool and policy[field] is None:
            return None
        return credit_units(policy[field])
    token_field = 'global_daily_tokens' if global_pool else 'daily_tokens'
    tokens = policy.get(token_field)
    if global_pool and tokens is None:
        return None
    if type(tokens) is not int or not 0 <= tokens <= 100_000_000_000:
        raise ValueError('invalid_daily_token_limit')
    # One default-rate Credit covers 1,000 tokens; avoid float conversion.
    return tokens * (CREDIT_SCALE // 1000)


def _count(value):
    return type(value) is int and 0 <= value <= MAX_USAGE_TOKENS


def usage_details(response):
    usage = response.get('usage') if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return None
    prompt, output, total = (usage.get(key) for key in
                             ('prompt_tokens', 'completion_tokens', 'total_tokens'))
    if any(key in usage and usage[key] is not None and not _count(usage[key])
           for key in ('prompt_tokens', 'completion_tokens', 'total_tokens')):
        return None
    prompt_ok, output_ok, total_ok = _count(prompt), _count(output), _count(total)
    if not (prompt_ok and output_ok):
        if not total_ok:
            return None
        # A provider reporting only total usage gives no evidence of a cheaper
        # category. Valid partial counters can still raise its lower bound.
        total = max(total, (prompt if prompt_ok else 0) + (output if output_ok else 0))
        return {'total': total, 'input': None, 'output': None, 'cacheRead': 0, 'cacheWrite': 0}
    total = max(prompt + output, total if total_ok else 0)
    if total > MAX_USAGE_TOKENS:
        return None  # Keep the reservation for implausibly large provider counts.
    details = usage.get('prompt_tokens_details')
    read, write = 0, 0
    valid_cache = details is None or isinstance(details, dict)
    if isinstance(details, dict):
        candidates = [details[key] for key in ('cache_creation_tokens', 'cache_write_tokens') if key in details]
        read = details.get('cached_tokens', 0)
        valid_cache = (_count(read) and all(_count(value) for value in candidates)
                       and len(set(candidates)) <= 1)
        if valid_cache:
            # These two write fields are aliases, not additive categories.
            write = max(candidates, default=0)
            valid_cache = read + write <= prompt
    if not valid_cache:
        # The total input is known but its categories cannot be trusted.
        return {'total': total, 'input': None, 'output': output, 'cacheRead': 0, 'cacheWrite': 0}
    return {'total': total, 'input': prompt - read - write,
            'output': output, 'cacheRead': read, 'cacheWrite': write}


def _rate_units(rate):
    return {key: int(_decimal(value, 10_000, scale=RATE_SCALE) * RATE_SCALE)
            for key, value in normalize_rates(rate).items()}


def charge_units(details, rate):
    if not isinstance(details, dict) or not _count(details.get('total')):
        raise ValueError('invalid_credit_usage')
    rates = _rate_units(rate)
    known, numerator = 0, 0
    for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
        value = details.get(key)
        if value is None and key in ('input', 'output'):
            continue
        if not _count(value):
            raise ValueError('invalid_credit_usage')
        known += value
        numerator += value * rates[key]
    unknown = max(0, details['total'] - known)
    numerator += unknown * max(rates.values())
    return (numerator + RATE_DIVISOR - 1) // RATE_DIVISOR


def reservation_units(input_bound, output, rate):
    if type(input_bound) is not int or input_bound < 0 or type(output) is not int or output < 0:
        raise ValueError('invalid_credit_reservation')
    rates = _rate_units(rate)
    # A provider may return only total usage or unusable cache categories. Those
    # tokens must be settled at the highest category rate, including output, so
    # reserve that worst case before forwarding and refund the difference later.
    numerator = (input_bound + output) * max(rates.values())
    return (numerator + RATE_DIVISOR - 1) // RATE_DIVISOR


def output_capacity(available_units, input_bound, output, rate):
    if type(available_units) is not int or available_units < 0:
        raise ValueError('invalid_credit_capacity')
    # Validate even when zero/free rates allow the full output budget.
    reservation_units(input_bound, output, rate)
    low, high = 0, output
    while low < high:
        middle = (low + high + 1) // 2
        if reservation_units(input_bound, middle, rate) <= available_units:
            low = middle
        else:
            high = middle - 1
    return low
