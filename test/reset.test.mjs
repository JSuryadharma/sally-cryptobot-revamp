import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetData, RESET_SCOPES } from '../src/engine/reset.js';

const runNow = (fn) => fn();

test('account reset clears the trading account but keeps strategy data and settings', async () => {
  const deleted = [];
  const { status } = await resetData('account', { del: async (k) => deleted.push(k), lease: runNow });
  assert.equal(status, 200);
  assert.ok(deleted.includes('portfolio.json') && deleted.includes('engine-state.json'));
  assert.ok(!deleted.includes('paper-breakout-journal.json'));
  assert.ok(!deleted.includes('autopilot.json'));
  assert.ok(!deleted.includes('settings.json'));
});

test('each scope includes the one before it', () => {
  for (const k of RESET_SCOPES.account) assert.ok(RESET_SCOPES.history.includes(k));
  for (const k of RESET_SCOPES.history) assert.ok(RESET_SCOPES.everything.includes(k));
  assert.ok(RESET_SCOPES.everything.includes('settings.json'));
});

test('an unknown scope deletes nothing', async () => {
  const deleted = [];
  const { status } = await resetData('all', { del: async (k) => deleted.push(k), lease: runNow });
  assert.equal(status, 400);
  assert.deepEqual(deleted, []);
});
