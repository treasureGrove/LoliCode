import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_TEXT_LIMITS, TextBudget } from '../src/text-budget.mjs';

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lolicode-text-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, limits: { ...DEFAULT_TEXT_LIMITS, maxAccounts: 256, ...overrides } };
}

test('global and account token buckets share all rooms, refill at their exact rates and do not refill on clock rollback', t => {
  let now = Date.UTC(2026, 9, 27);
  const f = fixture(t, { maxTextBytesPerSecond: 8, maxTextBurstBytes: 10,
    maxTextAccountBytesPerSecond: 2, maxTextAccountBurstBytes: 8 });
  const budget = new TextBudget(f.directory, { limits: f.limits, now: () => now });
  budget.consume('1', 6);
  assert.throws(() => budget.consume('1', 3), /text_rate_limited/);
  assert.throws(() => budget.consume('2', 5), /text_rate_limited/);
  budget.consume('2', 4);
  now += 1000;
  budget.consume('1', 4);
  now -= 1000;
  assert.throws(() => budget.consume('1', 1), /text_rate_limited/);
  assert.equal(budget.metrics().accountBuckets, 2);
});

test('durable reservations survive restart, cannot reset on rollback, and renew only in a later UTC month', t => {
  let now = Date.UTC(2026, 9, 27);
  const f = fixture(t, { maxTextMonthlyBytes: 32 });
  const create = () => new TextBudget(f.directory, { limits: f.limits, now: () => now });
  const first = create();
  first.consume('1', 8);
  assert.equal(JSON.parse(readFileSync(first.path)).reservedBytes, 32);
  first.consume('1', 24);
  assert.throws(() => first.consume('1', 1), /text_monthly_quota_exhausted/);
  const restarted = create();
  assert.throws(() => restarted.consume('2', 1), /text_monthly_quota_exhausted/);
  now = Date.UTC(2026, 8, 27);
  assert.throws(() => restarted.consume('2', 1), /text_monthly_quota_exhausted/);
  now = Date.UTC(2026, 10, 1);
  restarted.consume('2', 1);
  assert.deepEqual(JSON.parse(readFileSync(first.path)), { v: 1, month: '2026-11', reservedBytes: 32 });
});

test('unused reservations are conservatively lost on process restart, rather than granted twice', t => {
  const f = fixture(t, { maxTextMonthlyBytes: 16 });
  const first = new TextBudget(f.directory, { limits: f.limits });
  first.consume('1', 1);
  const restarted = new TextBudget(f.directory, { limits: f.limits });
  assert.throws(() => restarted.consume('1', 1), /text_monthly_quota_exhausted/);
});

test('failed durable reservation sends no credit and stays unavailable even if the IO fault disappears', t => {
  const f = fixture(t);
  const budget = new TextBudget(f.directory, { limits: f.limits });
  const persist = budget.persist;
  budget.persist = () => { throw new Error('Injected filesystem failure'); };
  assert.throws(() => budget.consume('1', 100), /text_budget_unavailable/);
  budget.persist = persist;
  assert.throws(() => budget.consume('1', 100), /text_budget_unavailable/);
  assert.equal(budget.metrics().monthlyReservedBytes, 0);
});

test('corrupt ledgers are preserved and cannot silently reset quota; test overrides may only lower hard ceilings', t => {
  const f = fixture(t);
  const path = join(f.directory, 'text-budget.json');
  const corrupt = '{invalid-private-ledger';
  writeFileSync(path, corrupt);
  const budget = new TextBudget(f.directory, { limits: f.limits });
  assert.throws(() => budget.consume('1', 1), /text_budget_unavailable/);
  assert.equal(readFileSync(path, 'utf8'), corrupt);
  for (const key of Object.keys(DEFAULT_TEXT_LIMITS)) {
    assert.throws(() => new TextBudget(f.directory, { limits: { ...f.limits, [key]: DEFAULT_TEXT_LIMITS[key] + 1 } }), /Invalid text relay limit/);
  }
});
