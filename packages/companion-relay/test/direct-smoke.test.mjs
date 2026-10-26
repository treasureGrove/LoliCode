import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './account-support.mjs';
import { runDirectSmoke } from './public-direct-smoke.mjs';

test('production-negative smoke runs locally without account credentials, task data or persistent room creation', async t => {
  const { relay } = await fixture(t);
  const report = await runDirectSmoke({ httpBase: `http://127.0.0.1:${relay.address.port}/v2`,
    wsUrl: relay.url, allowInsecureLocal: true });
  assert.equal(report.realAccountUsed, false);
  assert.equal(report.anonymousLegacyRejected, true);
  assert.equal(relay.store.devices.size, 0);
  assert.equal(relay.store.rooms.size, 0);
  assert.equal(relay.metrics().taskForwardedBytes, 0);
});

test('smoke refuses caller-selected production origins or implicit cleartext', async () => {
  for (const options of [{ httpBase: 'https://evil.invalid/v2' }, { httpBase: 'http://127.0.0.1/v2' },
    { httpBase: 'http://evil.invalid/v2', wsUrl: 'ws://evil.invalid/companion', allowInsecureLocal: true }]) {
    await assert.rejects(runDirectSmoke(options));
  }
});
