// News feed for the dashboard: free, keyless RSS sources for Indonesian stocks
// and crypto, each headline tagged with the tickers it mentions and a tone
// score, then compared with what the price did after it was published.
//
// "Correlation" here is measured, not assumed: for every tagged headline the
// app records the daily close before it came out and the next daily close
// after it, and per ticker it reports how often the headline's tone matched
// the next-day move, plus the Pearson correlation between tone and that move.
import { parseFeed } from './rss.js';
import { buildMatchers, tagTickers, sentimentOf } from './tagger.js';

export const NEWS_JOURNAL_KEY = 'news-journal.json';
export const PRICE_HISTORY_KEY = 'price-history.json';
export const NEWS_REFRESH_MS = 15 * 60_000;
const KEEP_DAYS = 21;
const KEEP_ITEMS = 500;
const FETCH_TIMEOUT_MS = 10_000;
const HISTORY_DAYS = 60;

export function newsFeeds({ idx = [] } = {}) {
  const feeds = [
    { id: 'google-id-saham', market: 'idx', url: 'https://news.google.com/rss/search?q=saham+OR+IHSG+OR+emiten&hl=id&gl=ID&ceid=ID:id' },
    { id: 'cnbc-id-market', market: 'idx', url: 'https://www.cnbcindonesia.com/market/rss' },
    { id: 'google-crypto', market: 'crypto', url: 'https://news.google.com/rss/search?q=bitcoin+OR+crypto+OR+ethereum&hl=en-US&gl=US&ceid=US:en' },
    { id: 'coindesk', market: 'crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { id: 'cointelegraph', market: 'crypto', url: 'https://cointelegraph.com/rss' }
  ];
  // One Google News query for the IDX watchlist codes, so each emiten gets its own headlines.
  if (idx.length) {
    const q = encodeURIComponent(`(${idx.slice(0, 20).join(' OR ')}) saham`);
    feeds.push({ id: 'google-id-watchlist', market: 'idx', url: `https://news.google.com/rss/search?q=${q}&hl=id&gl=ID&ceid=ID:id` });
  }
  return feeds;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SallyPaperBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function idOf(item) {
  const key = item.title.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, ' ').trim().slice(0, 120);
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return `n${(h >>> 0).toString(36)}`;
}

// Fetches every feed (failures are reported, not thrown) and merges new
// headlines into the journal. Same headline from two feeds is kept once.
export async function refreshNews(journal, { watchlists, nowMs = Date.now(), fetcher = fetchText }) {
  const matchers = buildMatchers(watchlists);
  const feeds = newsFeeds(watchlists);
  const seen = new Map((journal || []).map((n) => [n.id, n]));
  const errors = [];
  const results = await Promise.allSettled(feeds.map(async (feed) => ({ feed, items: parseFeed(await fetcher(feed.url)) })));
  let added = 0;
  results.forEach((r, k) => {
    if (r.status === 'rejected') { errors.push({ feed: feeds[k].id, error: r.reason?.message || String(r.reason) }); return; }
    for (const item of r.value.items) {
      const id = idOf(item);
      if (seen.has(id)) continue;
      const text = `${item.title}. ${item.summary || ''}`;
      const tickers = tagTickers(item.title, matchers);
      // Summaries add context but also noise: only use them when the title names nothing.
      const finalTickers = tickers.length ? tickers : tagTickers(text, matchers);
      seen.set(id, {
        id, title: item.title, link: item.link, source: item.source || r.value.feed.id, feed: r.value.feed.id,
        market: r.value.feed.market, publishedAt: new Date(item.publishedMs ?? nowMs).toISOString(), fetchedAt: new Date(nowMs).toISOString(),
        tickers: finalTickers, sentiment: sentimentOf(text)
      });
      added += 1;
    }
  });
  const cutoff = nowMs - KEEP_DAYS * 86_400_000;
  const merged = [...seen.values()]
    .filter((n) => Date.parse(n.publishedAt) >= cutoff && Date.parse(n.publishedAt) <= nowMs + 3_600_000)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, KEEP_ITEMS);
  return { journal: merged, added, errors, feeds: feeds.length };
}

// Compact daily closes per market for the correlation math, from the series
// the tick already loaded: { SYMBOL: [[closeMs, close], ...] }.
export function priceHistoryFrom(series, tfMs = 86_400_000) {
  const out = {};
  for (const [symbol, byTf] of Object.entries(series || {})) {
    const daily = byTf?.['1d'];
    if (!daily?.length) continue;
    out[symbol] = daily.slice(-HISTORY_DAYS).map((b) => [b.closeTime ?? b.time * 1000 + tfMs, b.close]);
  }
  return out;
}

function reactionFor(history, publishedMs, livePrice) {
  if (!history?.length) return null;
  let before = null;
  let after = null;
  for (const [closeMs, close] of history) {
    if (closeMs <= publishedMs) before = close;
    else { after = close; break; }
  }
  if (!before) return null;
  const nextDayPct = after ? Math.round((after / before - 1) * 10_000) / 100 : null;
  const latest = livePrice ?? history.at(-1)[1];
  return { beforeClose: before, nextClose: after, nextDayPct, sincePct: Math.round((latest / before - 1) * 10_000) / 100 };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 4) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100 : null;
}

// history: { crypto: { SYM: [[ms, close]] }, idx: {...} }; live: { crypto: { SYM: price }, idx: {...} }
export function correlateNews(journal, history, live = {}, { nowMs = Date.now(), days = 14 } = {}) {
  const cutoff = nowMs - days * 86_400_000;
  const items = [];
  const byTicker = new Map();
  for (const n of journal || []) {
    const publishedMs = Date.parse(n.publishedAt);
    const tickers = (n.tickers || []).map((t) => ({ ...t, reaction: reactionFor(history?.[t.market]?.[t.symbol], publishedMs, live?.[t.market]?.[t.symbol]) }));
    items.push({ ...n, tickers });
    if (publishedMs < cutoff) continue;
    for (const t of tickers) {
      const key = `${t.market}:${t.symbol}`;
      if (!byTicker.has(key)) byTicker.set(key, { market: t.market, symbol: t.symbol, count: 0, bullish: 0, bearish: 0, toneSum: 0, pairs: [], latestAt: n.publishedAt });
      const agg = byTicker.get(key);
      agg.count += 1;
      agg.toneSum += n.sentiment?.score || 0;
      if (n.sentiment?.label === 'bullish') agg.bullish += 1;
      if (n.sentiment?.label === 'bearish') agg.bearish += 1;
      if (t.reaction?.nextDayPct != null) agg.pairs.push([n.sentiment?.score || 0, t.reaction.nextDayPct]);
      if (t.reaction && agg.sincePct == null) agg.sincePct = t.reaction.sincePct;
    }
  }
  const tickers = [...byTicker.values()].map((a) => {
    const toned = a.pairs.filter(([s, r]) => s !== 0 && r !== 0);
    const agree = toned.filter(([s, r]) => Math.sign(s) === Math.sign(r)).length;
    return {
      market: a.market, symbol: a.symbol, count: a.count, bullish: a.bullish, bearish: a.bearish,
      avgTone: Math.round((a.toneSum / a.count) * 100) / 100,
      latestAt: a.latestAt,
      priceSinceLatestNewsPct: a.sincePct ?? null,
      measured: a.pairs.length,
      toneMatchedMovePct: toned.length ? Math.round((agree / toned.length) * 100) : null,
      toneMoveCorrelation: pearson(a.pairs.map((p) => p[0]), a.pairs.map((p) => p[1]))
    };
  }).sort((x, y) => y.count - x.count);
  return { items, tickers };
}
