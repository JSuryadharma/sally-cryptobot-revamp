// IDX (Indonesia Stock Exchange) market adapter.
//
// Data: Yahoo Finance's public chart endpoint (no key), tickers with the .JK
// suffix (BBCA -> BBCA.JK) and ^JKSE for the composite index (IHSG). Free and
// keyless, but unofficial and usually ~10-15 minutes delayed during the
// session. The robot only acts on daily closes, so the delay doesn't matter
// for its decisions.
//
// Daily candles are re-timed so the engine's "candle closes at time + 1 day"
// rule lands at 16:15 WIB (09:15 UTC) on the trading date: the end of IDX's
// post-closing session, where trades happen at the closing price. So the
// robot buys a breakout at that day's close, and a candle is never treated as
// closed while the session is still running. `date` stays the trading date.
import { enrichCandles } from '../indicators.js';
import { resolveEngineCfg } from '../engine/config.js';

export const IDX_REGIME_SYMBOL = 'IHSG';
export const IDX_LOT_SIZE = 100;
const DAY_S = 86_400;
const CLOSE_UTC_MIN = 9 * 60 + 15; // 16:15 WIB
const FETCH_TIMEOUT_MS = 12_000;
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const USER_AGENT = 'Mozilla/5.0 (compatible; SallyPaperBot/1.0)';

// Liquid IDX names (LQ45 members with large daily value), a starting list
// that can be edited in Settings.
export const DEFAULT_IDX_WATCHLIST = [
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII', 'ANTM', 'ADRO',
  'UNTR', 'ICBP', 'AMRT', 'KLBF', 'PGAS', 'PTBA', 'MDKA', 'BRIS'
];

// Company names, used by the news tagger (news/tagger.js) to link headlines to tickers.
export const IDX_NAMES = {
  BBCA: ['Bank Central Asia', 'BCA'], BBRI: ['Bank Rakyat Indonesia', 'BRI'], BMRI: ['Bank Mandiri', 'Mandiri'],
  BBNI: ['Bank Negara Indonesia', 'BNI'], TLKM: ['Telkom Indonesia', 'Telkom'], ASII: ['Astra International', 'Astra'],
  ANTM: ['Aneka Tambang', 'Antam'], ADRO: ['Adaro', 'AlamTri'], UNTR: ['United Tractors'], ICBP: ['Indofood CBP'],
  AMRT: ['Alfamart', 'Sumber Alfaria'], KLBF: ['Kalbe Farma', 'Kalbe'], PGAS: ['Perusahaan Gas Negara', 'PGN'],
  PTBA: ['Bukit Asam'], MDKA: ['Merdeka Copper'], BRIS: ['Bank Syariah Indonesia', 'BSI'], GOTO: ['GoTo', 'Gojek', 'Tokopedia'],
  INDF: ['Indofood Sukses Makmur', 'Indofood'], UNVR: ['Unilever Indonesia'], CPIN: ['Charoen Pokphand'], INCO: ['Vale Indonesia'],
  MEDC: ['Medco Energi', 'Medco'], ITMG: ['Indo Tambangraya'], TOWR: ['Sarana Menara'], BUKA: ['Bukalapak'], ARTO: ['Bank Jago'],
  EXCL: ['XL Axiata', 'XLSmart'], ISAT: ['Indosat'], SMGR: ['Semen Indonesia'], INKP: ['Indah Kiat'], TPIA: ['Chandra Asri'],
  BREN: ['Barito Renewables'], AMMN: ['Amman Mineral'], MBMA: ['Merdeka Battery'], HRUM: ['Harum Energy'], ACES: ['Ace Hardware Indonesia']
};

export function yahooTicker(symbol) {
  return symbol === IDX_REGIME_SYMBOL ? '^JKSE' : `${symbol}.JK`;
}

const SYMBOL_PATTERN = /^[A-Z]{4}$/;
export function normalizeIdxSymbol(value) {
  const s = String(value || '').toUpperCase().trim().replace(/\.JK$/, '');
  return SYMBOL_PATTERN.test(s) ? s : null;
}

// Trading date (YYYY-MM-DD) of a Yahoo bar, in the exchange's time zone.
function tradingDate(ts, gmtoffset) {
  return new Date((ts + (gmtoffset ?? 7 * 3600)) * 1000).toISOString().slice(0, 10);
}

// Yahoo v8 chart JSON -> daily candles timed for the engine (see the top note).
// Rows with missing prices (halts, holidays Yahoo pads) are dropped.
export function parseYahooDaily(json) {
  const result = json?.chart?.result?.[0];
  if (!result) {
    const message = json?.chart?.error?.description || 'no chart data';
    throw new Error(`Yahoo chart: ${message}`);
  }
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const offset = result.meta?.gmtoffset;
  const byDate = new Map();
  for (let i = 0; i < ts.length; i += 1) {
    const open = q.open?.[i]; const high = q.high?.[i]; const low = q.low?.[i]; const close = q.close?.[i];
    if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
    const date = tradingDate(ts[i], offset);
    const [y, m, d] = date.split('-').map(Number);
    const closeMs = Date.UTC(y, m - 1, d, 0, CLOSE_UTC_MIN);
    byDate.set(date, { time: closeMs / 1000 - DAY_S, date, open, high, low, close, volume: Number(q.volume?.[i]) || 0, closeTime: closeMs });
  }
  return {
    candles: [...byDate.values()].sort((a, b) => a.time - b.time),
    livePrice: Number.isFinite(result.meta?.regularMarketPrice) ? result.meta.regularMarketPrice : null,
    previousClose: Number.isFinite(result.meta?.chartPreviousClose) ? result.meta.chartPreviousClose : null
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchIdxDaily(symbol, { range = '2y', fetcher = fetchJson } = {}) {
  const path = `/v8/finance/chart/${encodeURIComponent(yahooTicker(symbol))}?range=${range}&interval=1d&includePrePost=false`;
  let lastError;
  for (const host of HOSTS) {
    try {
      return parseYahooDaily(await fetcher(host + path));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Yahoo Finance ${yahooTicker(symbol)}: ${lastError?.cause?.code || lastError?.message || 'failed'}`);
}

// Same shape as engine/candles.js loadLiveSeries: closed, enriched candles per
// timeframe, plus the forming candle for display prices.
export async function loadIdxSeries(symbols, { nowMs = Date.now(), fetcher, concurrency = 4 } = {}) {
  const series = {};
  const live = {};
  const errors = [];
  const queue = [...new Set(symbols)];
  async function worker() {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        const { candles, livePrice } = await fetchIdxDaily(symbol, { fetcher });
        const enriched = enrichCandles(candles);
        const closedCount = enriched.length && nowMs >= enriched.at(-1).closeTime ? enriched.length : enriched.length - 1;
        series[symbol] = { '1d': enriched.slice(0, closedCount) };
        const last = enriched.at(-1) || null;
        live[symbol] = { '1d': last && livePrice ? { ...last, close: closedCount === enriched.length ? last.close : livePrice } : last };
      } catch (error) {
        errors.push({ symbol, tf: '1d', error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return { series, live, errors };
}

// True while the regular session runs (Mon-Fri 09:00-16:15 WIB, holidays not known).
export function idxSessionOpen(nowMs = Date.now()) {
  const wib = new Date(nowMs + 7 * 3_600_000);
  const day = wib.getUTCDay();
  const minutes = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes < 16 * 60 + 15;
}

// Engine settings for the IDX book. Shares the account-wide risk settings;
// adds IDX's lot size, fees, liquidity floor and the pre-trade limits.
export function idxEngineCfg(settings) {
  const idx = settings.idx || {};
  return resolveEngineCfg({
    riskPerTradePct: settings.riskPerTradePct,
    maxPortfolioRiskPct: settings.maxPortfolioRiskPct,
    dailyLossLimitPct: settings.dailyLossLimitPct,
    maxConsecutiveLosses: settings.maxConsecutiveLosses,
    drawdownHaltPct: settings.drawdownHaltPct,
    tradeAllocationPct: settings.tradeAllocationPct,
    timeZone: 'Asia/Jakarta',
    regimeMode: 'btc200', // IHSG above its 200-day average
    maxOpenPositions: idx.maxOpenPositions ?? 4,
    maxNewEntriesPerBar: 3,
    // Typical online-broker fees: 0.15% buy, 0.25% sell (incl. 0.1% sales tax).
    roundTripCostPct: idx.roundTripCostPct ?? 0.4,
    slippagePct: 0.1,
    minNotionalUsdt: 100_000, // Rp, in the market's own currency
    minTradeQuoteVolumeUsdt: idx.minDailyValueIdr ?? 10_000_000_000, // Rp 10B a day
    quoteCurrency: 'IDR',
    regimeSymbol: IDX_REGIME_SYMBOL,
    regimeLabel: 'IHSG',
    lotSize: IDX_LOT_SIZE,
    breakoutEntry: 'close',
    earlyEntry: false,
    exitTf: null,
    btcGate: false,
    profiles: { scalping: false, swing: false, trend: false, breakout: false, breakout55: false, gap: false, idxBreakout: true },
    // day-trader-skill's risk manager limits (engine/preTradeCheck.js).
    preTrade: {
      minRewardRisk: 1,
      maxLossPerTradePct: Math.max(settings.riskPerTradePct * 1.25, 0.5),
      maxDailyRiskPct: 6,
      maxTradesPerDay: 3,
      cashBufferPct: 10
    }
  });
}
