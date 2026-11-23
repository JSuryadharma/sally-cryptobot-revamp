// Links a headline to the tickers it is about, and scores its tone.
//
// Tickers: all-caps codes match case-sensitively as whole words (BBCA, BTC),
// company and coin names match case-insensitively (Bank Mandiri, Solana).
// Tone: a small Indonesian + English word list. It is a rough signal for
// grouping headlines, not a trading signal on its own.
import { IDX_NAMES } from '../markets/idx.js';
import { CRYPTO_NAMES } from '../markets/crypto.js';

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function aliasRegex(alias) {
  const caps = alias === alias.toUpperCase() && /[A-Z]/.test(alias);
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(alias)}(?=$|[^A-Za-z0-9])`, caps ? '' : 'i');
}

// watchlists: { crypto: ['BTCUSDT', ...], idx: ['BBCA', ...] }
export function buildMatchers(watchlists) {
  const matchers = [];
  for (const symbol of new Set([...(watchlists.idx || []), ...Object.keys(IDX_NAMES)])) {
    const aliases = [symbol, ...(IDX_NAMES[symbol] || [])];
    matchers.push({ market: 'idx', symbol, res: aliases.map(aliasRegex) });
  }
  for (const symbol of new Set([...(watchlists.crypto || []), ...Object.keys(CRYPTO_NAMES)])) {
    const base = symbol.replace(/USDT$/, '');
    const aliases = [...new Set([...(CRYPTO_NAMES[symbol] || []), ...(base.length >= 3 ? [base] : [])])];
    matchers.push({ market: 'crypto', symbol, res: aliases.map(aliasRegex) });
  }
  return matchers;
}

export function tagTickers(text, matchers) {
  const found = [];
  for (const m of matchers) {
    if (m.res.some((re) => re.test(text))) found.push({ market: m.market, symbol: m.symbol });
  }
  return found;
}

const POSITIVE = [
  // English
  'surge', 'surges', 'surged', 'soar', 'soars', 'soared', 'rally', 'rallies', 'rallied', 'gain', 'gains', 'gained', 'jump', 'jumps', 'jumped',
  'record high', 'all-time high', 'bullish', 'rebound', 'rebounds', 'beat', 'beats', 'upgrade', 'upgraded', 'approval', 'approved', 'approves',
  'inflow', 'inflows', 'buyback', 'profit', 'profits', 'growth', 'rise', 'rises', 'rising', 'climb', 'climbs', 'outperform', 'breakout', 'adoption', 'partnership',
  // Indonesian
  'naik', 'menguat', 'penguatan', 'melonjak', 'melesat', 'meroket', 'rekor', 'laba', 'untung', 'tumbuh', 'pertumbuhan', 'positif', 'borong',
  'akumulasi', 'dividen', 'hijau', 'cuan', 'menanjak', 'ekspansi', 'optimis', 'net buy', 'beli', 'kenaikan', 'terbang', 'mengangkat'
];
const NEGATIVE = [
  'plunge', 'plunges', 'plunged', 'crash', 'crashes', 'crashed', 'drop', 'drops', 'dropped', 'fall', 'falls', 'fell', 'slump', 'slumps', 'sink', 'sinks',
  'tumble', 'tumbles', 'tumbled', 'bearish', 'loss', 'losses', 'hack', 'hacked', 'exploit', 'lawsuit', 'sues', 'ban', 'bans', 'banned', 'outflow', 'outflows',
  'sell-off', 'selloff', 'downgrade', 'downgraded', 'fraud', 'liquidation', 'liquidations', 'decline', 'declines', 'declined', 'warning', 'fears', 'probe', 'delist', 'default', 'bankrupt', 'bankruptcy',
  'turun', 'melemah', 'pelemahan', 'anjlok', 'ambruk', 'ambles', 'merosot', 'rugi', 'kerugian', 'negatif', 'net sell', 'koreksi', 'tertekan',
  'merah', 'longsor', 'gagal', 'gugatan', 'suspensi', 'pailit', 'pesimis', 'waspada', 'krisis', 'boncos', 'penurunan', 'jatuh', 'jeblok'
];
const POS_RES = POSITIVE.map((w) => new RegExp(`(^|[^\\p{L}])${escapeRe(w)}(?=$|[^\\p{L}])`, 'iu'));
const NEG_RES = NEGATIVE.map((w) => new RegExp(`(^|[^\\p{L}])${escapeRe(w)}(?=$|[^\\p{L}])`, 'iu'));

// -1 (bearish) .. +1 (bullish)
export function sentimentOf(text) {
  const pos = POS_RES.filter((re) => re.test(text)).length;
  const neg = NEG_RES.filter((re) => re.test(text)).length;
  const score = pos + neg ? (pos - neg) / (pos + neg) : 0;
  return { score: Math.round(score * 100) / 100, label: score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral', pos, neg };
}
