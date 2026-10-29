import test from 'node:test';
import assert from 'node:assert/strict';
import {withRetries, RuckusClient} from '../src/ruckus.mjs';
import {normalizeMac, sameApConnection} from '../src/sync.mjs';

test('retries five times at the requested intervals', async () => {
  const waits = [];
  let calls = 0;
  const result = await withRetries(async () => {
    if (++calls < 6) throw new Error('temporary failure');
    return 'ok';
  }, async ms => { waits.push(ms); });
  assert.equal(result, 'ok');
  assert.equal(calls, 6);
  assert.deepEqual(waits, [10_000, 20_000, 30_000, 40_000, 50_000]);
});

test('does not retry a permanent API error', async () => {
  const error = Object.assign(new Error('bad request'), {permanent: true});
  let calls = 0;
  await assert.rejects(withRetries(async () => { calls++; throw error; }, async () => {}), error);
  assert.equal(calls, 1);
});

test('rejects an incomplete paginated snapshot', async () => {
  const client = Object.create(RuckusClient.prototype);
  client.query = async () => ({totalCount: 2, firstIndex: 0, hasMore: false, list: [{apMac: 'A'}]});
  await assert.rejects(client.allPages('/v11_1/query/ap'), /incomplete snapshot/);
});

test('normalizes AP and client MACs', () => {
  assert.equal(normalizeMac('18:7c:0b:2e:f1:50'), '18:7C:0B:2E:F1:50');
  assert.equal(normalizeMac('187c0b2ef150'), '18:7C:0B:2E:F1:50');
  assert.throws(() => normalizeMac('not-a-mac'));
});

test('starts a new AP visit for every observed AP change, even at the same mapped location', () => {
  const sessionStart = new Date('2026-10-26T03:00:00Z');
  const current = {online: 1, ap_mac: 'AA:AA:AA:AA:AA:AA', ssid: 'ABH', session_start_at: sessionStart};
  assert.equal(sameApConnection(current, {apMac: current.ap_mac, ssid: 'ABH', sessionStart}), true);
  assert.equal(sameApConnection(current, {apMac: 'BB:BB:BB:BB:BB:BB', ssid: 'ABH', sessionStart}), false);
  assert.equal(sameApConnection(current, {apMac: current.ap_mac, ssid: 'ABH', sessionStart: new Date('2026-10-26T03:01:00Z')}), false);
  assert.equal(sameApConnection({...current, online: 0}, {apMac: current.ap_mac, ssid: 'ABH', sessionStart}), false);
});
