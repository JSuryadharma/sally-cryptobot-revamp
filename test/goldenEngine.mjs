// Regression snapshot for the strategy-module refactor: runs advance() over
// synthetic data with several configs and prints a digest of every fill and signal.
import { createHash } from 'node:crypto';
import { advance, createEngineState } from '../src/engine/core.js';
import { resolveEngineCfg } from '../src/engine/config.js';
import { createPortfolio } from '../src/engine/ledger.js';
import { syntheticSeries } from './helpers.mjs';

const symbols = ['BTCUSDT', 'AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
const START = Date.UTC(2025, 0, 1);
const full = syntheticSeries({ symbols, bars: 96 * 420, startMs: START, seedBase: 11 });
for (const s of symbols) for (const tf of Object.keys(full[s])) for (const b of full[s][tf]) b.volume *= 1000;
const end = START + 96 * 420 * 900_000;
const tradeStart = START + 230 * 86_400_000;
const variants = {
  closeBreakout: { breakoutEntry: 'close', earlyTf: '15m', exitTf: '15m' },
  touchBreakout: { breakoutEntry: 'touch:b0.75', earlyTf: '15m', exitTf: '15m' },
  nextClose: { breakoutEntry: 'nextClose', earlyTf: '15m', exitTf: null },
  hold: { breakoutEntry: 'hold:2', earlyTf: '15m', exitTf: '15m', profiles: { breakout: false, breakout55: true, gap: false } },
  gapOnly: { earlyTf: '15m', exitTf: '15m', profiles: { breakout: false, gap: true } },
  swingEarly: { earlyTf: '15m', exitTf: '15m', earlyEntry: true, profiles: { breakout: false, gap: false, swing: true, trend: true } },
  scalp: { earlyTf: '15m', exitTf: null, profiles: { breakout: false, gap: false, scalping: true }, enableBreakout: true }
};
const out = {};
for (const [name, v] of Object.entries(variants)) {
  const cfg = resolveEngineCfg({ minTradeQuoteVolumeUsdt: 0, preTrade: null, regimeMode: 'btc200', ...v });
  const pf = createPortfolio(10_000_000);
  const r = advance(createEngineState(), pf, full, { nowMs: end, startMs: tradeStart, usdIdrRate: 16000, cfg, tradeSymbols: symbols, keepAllTransactions: true });
  const strip = (t) => ({ ...t, id: undefined, tradeId: undefined });
  const payload = JSON.stringify({ tx: r.transactions.map(strip), sig: r.signals, risk: r.riskEvents, bal: pf.balanceIdr });
  out[name] = { tx: r.transactions.length, sig: r.signals.length, hash: createHash('sha1').update(payload).digest('hex').slice(0, 12) };
}
console.log(JSON.stringify(out, null, 1));
