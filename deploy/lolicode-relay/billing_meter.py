"""Administrator-priced token/request billing with exact Credit conversion.

Money is calculated using integers. Prices and Credit conversion have six decimal
places; token costs retain twelve places before the single microCredit rounding.
Derived floating-point rates are presentation data only.
"""
from copy import deepcopy
from decimal import Decimal, InvalidOperation
import math

import credit_meter


SCALE = 1_000_000
TOKEN_COST_SCALE = SCALE * SCALE
MAX_BILL_UNITS = 2**53 - 1
RATE_KEYS = frozenset(('input', 'output', 'cacheRead', 'cacheWrite'))


def default_billing_config():
    return {'currency': 'CNY', 'creditsPerUnit': 100, 'modelPrices': {}}


def _valid_model_id(value):
    return (isinstance(value, str) and 0 < len(value) <= 256 and value == value.strip()
            and ',' not in value
            and all(not character.isspace() and ord(character) >= 32 and ord(character) != 127
                    for character in value))


def _number_units(value, *, positive=False):
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise ValueError('invalid_billing_number')
    try:
        number = Decimal(str(value))
        scaled = number * SCALE
        if (number < 0 or number > 1_000_000 or (positive and number == 0)
                or scaled != scaled.to_integral_value()):
            raise ValueError('invalid_billing_number')
        return int(scaled)
    except (InvalidOperation, OverflowError):
        raise ValueError('invalid_billing_number') from None


def _json_number(units, scale=SCALE):
    whole, fraction = divmod(units, scale)
    return whole if not fraction else float(_amount(units, scale))


def _amount(numerator, scale):
    whole, fraction = divmod(numerator, scale)
    if not fraction:
        return str(whole)
    digits = len(str(scale)) - 1
    return str(whole) + '.' + str(fraction).rjust(digits, '0').rstrip('0')


def _bill(numerator, denominator):
    result = (numerator + denominator - 1) // denominator
    if result > MAX_BILL_UNITS:
        raise ValueError('billing_amount_too_large')
    return result


def normalize_billing_config(value):
    if not isinstance(value, dict) or set(value) != {'currency', 'creditsPerUnit', 'modelPrices'}:
        raise ValueError('invalid_billing_config')
    if value['currency'] not in ('USD', 'CNY'):
        raise ValueError('invalid_billing_currency')
    conversion = value['creditsPerUnit']
    conversion_units = None if conversion is None else _number_units(conversion, positive=True)
    models = value['modelPrices']
    if (not isinstance(models, dict) or len(models) > 2048
            or any(not _valid_model_id(model) for model in models)):
        raise ValueError('invalid_billing_models')
    if models and conversion_units is None:
        raise ValueError('billing_conversion_required')
    normalized = {}
    for model, entry in models.items():
        if not isinstance(entry, dict):
            raise ValueError('invalid_model_price')
        if entry.get('mode') == 'tokens':
            if (set(entry) != {'mode', 'prices'} or not isinstance(entry['prices'], dict)
                    or set(entry['prices']) != RATE_KEYS):
                raise ValueError('incomplete_token_prices')
            prices = {}
            for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
                units = _number_units(entry['prices'][key])
                # Price / million * Credits / currency / 1000 gives Credit / 1k.
                if units * conversion_units > 10_000 * SCALE * SCALE * 1000:
                    raise ValueError('derived_credit_rate_too_large')
                prices[key] = _json_number(units)
            normalized[model] = {'mode': 'tokens', 'prices': prices}
        elif entry.get('mode') == 'request':
            if set(entry) != {'mode', 'price'}:
                raise ValueError('incomplete_request_price')
            units = _number_units(entry['price'])
            _bill(units * conversion_units, SCALE)
            normalized[model] = {'mode': 'request', 'price': _json_number(units)}
        else:
            raise ValueError('invalid_billing_mode')
    return {'currency': value['currency'],
            'creditsPerUnit': None if conversion_units is None else _json_number(conversion_units),
            'modelPrices': normalized}


def billing_snapshot(policy, model_id):
    config = normalize_billing_config(policy.get('billing_config', default_billing_config()))
    if model_id not in config['modelPrices']:
        return {'mode': 'credits', 'rate': credit_meter.model_rate(policy, model_id)}
    revision = policy.get('billing_revision', 0)
    if type(revision) is not int or not 0 <= revision <= MAX_BILL_UNITS:
        raise ValueError('invalid_billing_revision')
    return {**deepcopy(config['modelPrices'][model_id]), 'currency': config['currency'],
            'creditsPerUnit': config['creditsPerUnit'], 'revision': revision}


def _snapshot(value):
    if not isinstance(value, dict):
        raise ValueError('invalid_billing_snapshot')
    if value.get('mode') == 'credits':
        if set(value) != {'mode', 'rate'}:
            raise ValueError('invalid_billing_snapshot')
        return {'mode': 'credits', 'rate': credit_meter.normalize_rates(value['rate'])}
    mode = value.get('mode')
    price_key = 'prices' if mode == 'tokens' else 'price'
    if (mode not in ('tokens', 'request')
            or set(value) != {'mode', price_key, 'currency', 'creditsPerUnit', 'revision'}):
        raise ValueError('invalid_billing_snapshot')
    revision = value['revision']
    if type(revision) is not int or not 0 <= revision <= MAX_BILL_UNITS:
        raise ValueError('invalid_billing_revision')
    config = normalize_billing_config({'currency': value['currency'],
        'creditsPerUnit': value['creditsPerUnit'],
        'modelPrices': {'snapshot': {'mode': mode, price_key: value[price_key]}}})
    return {**config['modelPrices']['snapshot'], 'currency': config['currency'],
            'creditsPerUnit': config['creditsPerUnit'], 'revision': revision}


def _token_bounds(inputbound, output):
    if type(inputbound) is not int or inputbound < 0 or type(output) is not int or output < 0:
        raise ValueError('invalid_billing_token_bounds')


def _prices(snapshot):
    return {key: _number_units(snapshot['prices'][key]) for key in RATE_KEYS}


def _usage_cost(details, prices):
    count = lambda value: type(value) is int and 0 <= value <= credit_meter.MAX_USAGE_TOKENS
    if not isinstance(details, dict) or not count(details.get('total')):
        raise ValueError('invalid_billing_usage')
    known, numerator = 0, 0
    for key in ('input', 'output', 'cacheRead', 'cacheWrite'):
        value = details.get(key)
        if value is None and key in ('input', 'output'):
            continue
        if not count(value):
            raise ValueError('invalid_billing_usage')
        known += value
        numerator += value * prices[key]
    return numerator + max(0, details['total'] - known) * max(prices.values())


def reservation_units(inputbound, output, snapshot):
    _token_bounds(inputbound, output)
    snapshot = _snapshot(snapshot)
    if snapshot['mode'] == 'credits':
        return _bill(credit_meter.reservation_units(inputbound, output, snapshot['rate']), 1)
    conversion = _number_units(snapshot['creditsPerUnit'], positive=True)
    if snapshot['mode'] == 'request':
        return _bill(_number_units(snapshot['price']) * conversion, SCALE)
    numerator = (inputbound + output) * max(_prices(snapshot).values())
    return _bill(numerator * conversion, TOKEN_COST_SCALE)


def charge_units(details, snapshot):
    snapshot = _snapshot(snapshot)
    if snapshot['mode'] == 'credits':
        return _bill(credit_meter.charge_units(details, snapshot['rate']), 1)
    conversion = _number_units(snapshot['creditsPerUnit'], positive=True)
    if snapshot['mode'] == 'request':
        return _bill(_number_units(snapshot['price']) * conversion, SCALE)
    return _bill(_usage_cost(details, _prices(snapshot)) * conversion, TOKEN_COST_SCALE)


def output_capacity(available, inputbound, output, snapshot):
    if type(available) is not int or not 0 <= available <= MAX_BILL_UNITS:
        raise ValueError('invalid_billing_capacity')
    _token_bounds(inputbound, output)
    snapshot = _snapshot(snapshot)
    if snapshot['mode'] == 'credits':
        return credit_meter.output_capacity(available, inputbound, output, snapshot['rate'])
    if snapshot['mode'] == 'request':
        return output if reservation_units(inputbound, output, snapshot) <= available else 0
    # Compare the exact numerator, so an unaffordable candidate above the bill
    # limit shrinks the search rather than aborting a smaller valid request.
    per_token = max(_prices(snapshot).values()) * _number_units(snapshot['creditsPerUnit'], positive=True)
    low, high = 0, output
    while low < high:
        middle = (low + high + 1) // 2
        if (inputbound + middle) * per_token <= available * TOKEN_COST_SCALE:
            low = middle
        else:
            high = middle - 1
    return low


def cost_details(details, snapshot, reserved_tokens=None):
    snapshot = _snapshot(snapshot)
    if snapshot['mode'] == 'credits':
        return None
    if snapshot['mode'] == 'request':
        charge_units(details, snapshot)  # Validate the safe bill range.
        amount, basis = _amount(_number_units(snapshot['price']), SCALE), 'request'
    elif reserved_tokens is not None:
        if not isinstance(reserved_tokens, (tuple, list)) or len(reserved_tokens) != 2:
            raise ValueError('invalid_billing_reservation')
        inputbound, output = reserved_tokens
        reservation_units(inputbound, output, snapshot)
        numerator = (inputbound + output) * max(_prices(snapshot).values())
        amount, basis = _amount(numerator, TOKEN_COST_SCALE), 'reservation'
    else:
        charge_units(details, snapshot)
        amount = _amount(_usage_cost(details, _prices(snapshot)), TOKEN_COST_SCALE)
        basis = 'usage'
    return {'currency': snapshot['currency'], 'amount': amount, 'basis': basis,
            'mode': snapshot['mode'], 'creditsPerUnit': snapshot['creditsPerUnit']}


def derived_credit_rate(snapshot):
    snapshot = _snapshot(snapshot)
    if snapshot['mode'] == 'credits':
        return deepcopy(snapshot['rate'])
    if snapshot['mode'] == 'request':
        return None
    conversion = _number_units(snapshot['creditsPerUnit'], positive=True)
    # Presentation only: never feed these approximate JSON numbers into billing.
    return {key: _json_number(value * conversion, SCALE * SCALE * 1000)
            for key, value in _prices(snapshot).items()}
