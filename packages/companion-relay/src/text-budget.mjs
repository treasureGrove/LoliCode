import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_TEXT_LIMITS = Object.freeze({ maxTextFrameBytes: 8192, maxTextBufferedBytes: 32 * 1024,
  maxTextBytesPerSecond: 8 * 1024, maxTextBurstBytes: 16 * 1024,
  maxTextAccountBytesPerSecond: 2 * 1024, maxTextAccountBurstBytes: 8 * 1024,
  maxTextMonthlyBytes: 2 * 1024 * 1024 * 1024 });
const RESERVATION_BYTES = 64 * 1024;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class TextBudgetError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new TextBudgetError(code); };

// A token bucket limits live egress. A separate durable reservation limits the
// UTC-month total even if the process dies between reservation and socket write.
export class TextBudget {
  constructor(directory, { limits, now = Date.now }) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'text-budget.json');
    this.limits = limits;
    this.now = now;
    for (const [name, ceiling] of Object.entries(DEFAULT_TEXT_LIMITS)) {
      if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > ceiling) throw new Error('Invalid text relay limit');
    }
    this.global = { at: now(), tokens: limits.maxTextBurstBytes };
    this.accounts = new Map();
    this.remainingReservation = 0;
    this.state = { v: 1, month: this.month(), reservedBytes: 0 };
    this.unavailable = false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      if (existsSync(this.path)) {
        const bytes = readFileSync(this.path);
        if (bytes.length > 1024) throw new Error('Invalid text ledger');
        const state = JSON.parse(bytes.toString('utf8'));
        if (!state || Object.keys(state).sort().join(',') !== 'month,reservedBytes,v' || state.v !== 1
          || !MONTH.test(state.month) || !Number.isSafeInteger(state.reservedBytes) || state.reservedBytes < 0
          || state.reservedBytes > DEFAULT_TEXT_LIMITS.maxTextMonthlyBytes) throw new Error('Invalid text ledger');
        this.state = state;
      }
    } catch {
      // Preserve a corrupt/unreadable ledger. Direct signaling remains usable,
      // but no text may be sent or a fresh empty ledger silently substituted.
      this.unavailable = true;
    }
  }

  month() { return new Date(this.now()).toISOString().slice(0, 7); }

  persist(state) {
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') {
        chmodSync(this.path, 0o600);
        const directory = openSync(this.directory, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the committed/previous ledger. */ }
      throw error;
    }
  }

  refill(bucket, rate, burst, time) {
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, time - bucket.at) * rate / 1000);
    bucket.at = Math.max(bucket.at, time); // Clock rollback cannot refill credit.
  }

  consume(accountId, bytes) {
    if (this.unavailable) fail('text_budget_unavailable');
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.limits.maxTextFrameBytes) fail('invalid_text');
    let account = this.accounts.get(accountId);
    if (!account) {
      if (this.accounts.size >= this.limits.maxAccounts) fail('text_capacity');
      account = { at: this.now(), tokens: this.limits.maxTextAccountBurstBytes };
      this.accounts.set(accountId, account);
    }
    const time = this.now();
    this.refill(this.global, this.limits.maxTextBytesPerSecond, this.limits.maxTextBurstBytes, time);
    this.refill(account, this.limits.maxTextAccountBytesPerSecond, this.limits.maxTextAccountBurstBytes, time);
    if (bytes > this.global.tokens || bytes > account.tokens) fail('text_rate_limited');
    const month = this.month();
    // A backwards wall clock never resets the persisted quota.
    if (month > this.state.month) { this.state = { v: 1, month, reservedBytes: 0 }; this.remainingReservation = 0; }
    if (this.remainingReservation < bytes) {
      const reservation = Math.min(RESERVATION_BYTES, this.limits.maxTextMonthlyBytes - this.state.reservedBytes);
      if (reservation < bytes - this.remainingReservation) fail('text_monthly_quota_exhausted');
      const next = { ...this.state, reservedBytes: this.state.reservedBytes + reservation };
      try { this.persist(next); } catch { this.unavailable = true; fail('text_budget_unavailable'); }
      this.state = next;
      this.remainingReservation += reservation;
    }
    this.remainingReservation -= bytes;
    this.global.tokens -= bytes;
    account.tokens -= bytes;
  }

  metrics() {
    return { available: !this.unavailable, month: this.state.month, monthlyReservedBytes: this.state.reservedBytes,
      monthlyLimitBytes: this.limits.maxTextMonthlyBytes, accountBuckets: this.accounts.size,
      globalBytesPerSecond: this.limits.maxTextBytesPerSecond, globalBurstBytes: this.limits.maxTextBurstBytes,
      accountBytesPerSecond: this.limits.maxTextAccountBytesPerSecond, accountBurstBytes: this.limits.maxTextAccountBurstBytes };
  }
}
