"""Canonical Credit balances and prices, independent of display currency.

Balance arithmetic uses integer microCredit. Legacy flat fields are projections
of the canonical balance; prices describe Credit per million tokens even when
an old stored billing snapshot used a currency conversion.
"""
from copy import deepcopy
from decimal import Decimal

from billing_meter import reservation_units
from credit_meter import credit_value


MAX_REVISION = 2**53 - 1


def _integer(value, *, revision=False):
    if type(value) is not int or value < 0 or (revision and value > MAX_REVISION):
        raise ValueError('invalid_quota_snapshot')
    return value


def credit_balance(limit_units, used_units, reserved_units, *, pricing_revision=0, ledger_revision=0):
    """Keep historical usage if an administrator lowers the limit below it."""
    limit = _integer(limit_units)
    used = _integer(used_units)
    reserved = _integer(reserved_units)
    return {'unit': 'Credit', 'limit': credit_value(limit), 'used': credit_value(used),
            'reserved': credit_value(reserved), 'remaining': credit_value(max(0, limit - used - reserved)),
            'pricingRevision': _integer(pricing_revision, revision=True),
            'ledgerRevision': _integer(ledger_revision, revision=True)}


def credit_projection(balance):
    """Never recalculate a second balance for compatibility fields."""
    return {'creditBalance': deepcopy(balance), 'creditUnit': balance['unit'],
            'creditLimit': balance['limit'], 'creditsUsed': balance['used'],
            'creditsReserved': balance['reserved'], 'creditsRemaining': balance['remaining']}


def _number(value):
    return int(value) if value == value.to_integral_value() else float(value)


def credit_pricing(snapshot):
    """Project a validated historical/current price into a Credit-only contract.

    Decimal multiplication avoids an intermediate rounded rate. Returned JSON
    numbers are display metadata, never inputs to the settlement calculation.
    """
    reservation_units(0, 0, snapshot)  # Validate every supported snapshot mode.
    mode = snapshot['mode']
    if mode == 'request':
        price = Decimal(str(snapshot['price'])) * Decimal(str(snapshot['creditsPerUnit']))
        return {'unit': 'Credit', 'mode': 'request', 'creditsPerRequest': _number(price)}
    if mode == 'credits':
        prices = {key: _number(Decimal(str(value)) * 1000) for key, value in snapshot['rate'].items()}
    else:
        conversion = Decimal(str(snapshot['creditsPerUnit']))
        prices = {key: _number(Decimal(str(value)) * conversion)
                  for key, value in snapshot['prices'].items()}
    return {'unit': 'Credit', 'mode': 'tokens', 'perTokens': 1000000, 'prices': prices}
