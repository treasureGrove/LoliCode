# Credit accounting and synchronization

Credit is the only daily allowance and the only balance unit. A request count
is a statistic; concurrency and RPM remain independent traffic controls.
There is no USD/CNY balance switch or automatic foreign-exchange conversion.

## Pricing

Administrators edit input, output, cache-read and cache-write prices in
Credit per 1,000,000 tokens. The optional CNY reference helper fills the draft:

`Credit/M = reference CNY/M × 100 × (1 + markupPercent / 100)`

The default markup is 10%. A reference yuan represents 100 Credit; it is a
pricing aid, not a cash balance or a top-up implementation. Applying the helper
does not save a policy until the administrator saves the entire form.
User-edited quotes use two decimals; existing unedited quotes retain their
precision during migration. Request settlement still uses microCredit.

The current reference models are DeepSeek Flash at the fixed official peak
list price and GLM-5.3-Flash at the standard API reference price. Cache writes
use ordinary input prices; cache hits use their own price. Published references
are not automatically downloaded or substituted for administrator prices.

The stored/API `modelCreditRates` field retains its historical Credit/1,000
token unit for old desktops. The editor divides by 1,000 on save. New public
`creditPricing` metadata explicitly says Credit/1,000,000 tokens. Only the
integer calculation is used for charging, never a floating-point UI preview.

Legacy monetary token prices migrate by multiplying the existing price by
the existing Credit conversion. They do not receive the markup again. The
active monetary model-price map is then cleared. Existing monetary request
snapshots remain readable and settle at their frozen terms. Legacy fixed-request
prices cannot be converted into token prices without a pricing decision.

## Authoritative balance

The backend computes `quota.creditBalance` once from a single SQLite read
snapshot: unit, limit, used, reserved, remaining, pricingRevision and
ledgerRevision. The old flat Credit fields are projections of that same
result. Remaining Credit is `max(0, limit - used - reserved)`.

An additive ledger revision increments in the same transaction as a reserve,
first settlement or recovery that actually changes Credit state. Repeated
settlement/recovery does not change the revision. A saved policy revision
identifies allowance/price changes. Probes do not consume user Credit or
change the Credit ledger revision.

Root administrators can inspect existing relay accounts and set a per-account
daily Credit override or pause new requests. A null override inherits the
current default; zero allows no paid consumption. These controls do not reset
usage or rewrite historical requests, and in-flight requests still settle.
Account edits use a separate compare-and-swap revision and advance the shared
ledger revision in the same transaction. The existing CLI uses the same path.
The account list shows only accounts that have connected to the relay, and
does not expose gateway credentials. Its global usage remains the whole-site
pool even while filtering or paging individual accounts.

Both daily request limits are stored as null when disabled. The old account
API retains numeric compatibility fields for installed clients, together with
`requestsUnlimited: true`; those protocol values are not enforced limits.

## Client synchronization

The desktop uses one shared quota query and one native refresh path. A refresh
reads a single backend response, synchronizes the sponsored model catalog and
returns that same balance snapshot. Completing a model request, account-session
changes, a manual refresh, focus/reconnection and short periodic refreshes
invalidate or refresh that shared state. Session guards prevent a response from
an old login from replacing a new login's balance.

The web account prefers the same complete `creditBalance` object. Legacy flat
responses are handled as a whole compatibility representation; token counts
and request counts never reconstruct a new Credit balance.

## Data preservation and provenance

Deployment is additive and checks a cloned ledger before production changes.
It preserves requests, existing Credit charges, frozen pricing snapshots and
the administrator's current daily allowance. Changing pricing does not reprice
history. Failed upstream calls refund reservations; ambiguous completions keep
the existing conservative accounting rules.

The shared-query, draft and budget/spend patterns were reviewed against the
MIT community portions of BerriAI/LiteLLM at revision
`73aaf9e3daec8bb174accdf56ecade90b34c27c8`. Attribution and the upstream license
are in `third-party/notices/litellm.md` and `third-party/notices/litellm-LICENSE`. The existing gateway stays in place.
