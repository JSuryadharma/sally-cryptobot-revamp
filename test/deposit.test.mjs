import test from 'node:test';
import assert from 'node:assert/strict';
import { syncStartingBalance } from '../src/engine/deposit.js';
import { normalize } from '../src/settings.js';

test('raising the starting balance adds cash and shifts the risk references', () => {
  const portfolio = { initialBalanceIdr: 10_000_000, balanceIdr: 4_000_000, positions: { BTCUSDT: { qty: 1 } } };
  const risk = { peakEquityIdr: 11_000_000, dayStartEquityIdr: 10_500_000 };
  const idxRisk = { peakEquityIdr: 10_200_000 };
  assert.equal(syncStartingBalance(portfolio, 20_000_000, [risk, idxRisk, undefined]), 10_000_000);
  assert.equal(portfolio.balanceIdr, 14_000_000);
  assert.equal(portfolio.initialBalanceIdr, 20_000_000);
  assert.deepEqual(portfolio.positions, { BTCUSDT: { qty: 1 } });
  assert.equal(risk.peakEquityIdr, 21_000_000);
  assert.equal(risk.dayStartEquityIdr, 20_500_000);
  assert.equal(idxRisk.peakEquityIdr, 20_200_000);
  assert.equal(portfolio.deposits.length, 1);
  assert.equal(syncStartingBalance(portfolio, 20_000_000, [risk]), 0);
});

test('old settings move to the Rp 20M starting balance once; later edits stick', () => {
  const migrated = normalize({ initialBalanceIdr: 10_000_000 });
  assert.equal(migrated.initialBalanceIdr, 20_000_000);
  const edited = normalize({ ...migrated, initialBalanceIdr: 15_000_000 });
  assert.equal(edited.initialBalanceIdr, 15_000_000);
});
