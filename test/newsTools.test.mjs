import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, decodeText } from '../src/news/rss.js';
import { buildMatchers, tagTickers, sentimentOf } from '../src/news/tagger.js';
import { refreshNews, correlateNews, priceHistoryFrom } from '../src/news/service.js';
import { scanSetups, runScanner } from '../src/tools/scanner.js';
import { timeMachine } from '../src/tools/timeMachine.js';

const GOOGLE_RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Saham BBCA Melonjak, Asing Borong Rp 1 Triliun - CNBC Indonesia</title><link>https://news.google.com/articles/abc</link><pubDate>Thu, 19 Nov 2026 03:00:00 GMT</pubDate><source url="https://www.cnbcindonesia.com">CNBC Indonesia</source><description>&lt;a href="x"&gt;Saham BBCA&lt;/a&gt; naik</description></item>
<item><title><![CDATA[Bitcoin plunges as ETF outflows hit record & miners sell]]></title><link>https://example.com/btc</link><pubDate>Thu, 19 Nov 2026 05:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

test('RSS parser reads Google News items, strips the source suffix and unsafe links', () => {
  const items = parseFeed(GOOGLE_RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Saham BBCA Melonjak, Asing Borong Rp 1 Triliun');
  assert.equal(items[0].source, 'CNBC Indonesia');
  assert.equal(items[0].summary, 'Saham BBCA naik');
  assert.equal(items[1].title, 'Bitcoin plunges as ETF outflows hit record & miners sell');
  assert.equal(decodeText('&lt;script&gt;x&lt;/script&gt; ok'), 'x ok');
});

test('tagger links codes and names to tickers; tone from ID and EN words', () => {
  const m = buildMatchers({ crypto: ['BTCUSDT', 'SOLUSDT'], idx: ['BBCA', 'TLKM'] });
  assert.deepEqual(tagTickers('Saham BBCA melonjak', m).map((t) => t.symbol), ['BBCA']);
  assert.deepEqual(tagTickers('Laba Telkom Indonesia tumbuh 8%', m).map((t) => t.symbol), ['TLKM']);
  assert.deepEqual(tagTickers('Bitcoin and Solana rally', m).map((t) => t.symbol).sort(), ['BTCUSDT', 'SOLUSDT']);
  assert.deepEqual(tagTickers('the solution was absolute', m), []);
  assert.equal(sentimentOf('Saham BBCA melonjak, asing borong').label, 'bullish');
  assert.equal(sentimentOf('Bitcoin plunges as ETF outflows hit record').label, 'bearish');
  assert.equal(sentimentOf('IHSG dibuka').label, 'neutral');
});

test('refreshNews merges feeds once per headline and survives a failing feed', async () => {
  const nowMs = Date.parse('2026-11-19T06:00:00Z');
  const fetcher = async (url) => { if (url.includes('coindesk')) throw new Error('HTTP 503'); return GOOGLE_RSS; };
  const { journal, errors, added } = await refreshNews([], { watchlists: { crypto: ['BTCUSDT'], idx: ['BBCA'] }, nowMs, fetcher });
  assert.equal(journal.length, 2);
  assert.ok(added >= 2);
  assert.equal(errors.length, 1);
  const bbca = journal.find((n) => n.title.startsWith('Saham BBCA'));
  assert.deepEqual(bbca.tickers, [{ market: 'idx', symbol: 'BBCA' }]);
  const again = await refreshNews(journal, { watchlists: { crypto: ['BTCUSDT'], idx: ['BBCA'] }, nowMs, fetcher });
  assert.equal(again.journal.length, 2);
});

test('correlateNews measures the next-day move after each headline and tone agreement per ticker', () => {
  const day = 86_400_000;
  const t0 = Date.parse('2026-11-01T09:15:00Z');
  const closes = [100, 102, 101, 104, 103, 107, 106, 101];
  const history = { idx: { BBCA: closes.map((c, k) => [t0 + k * day, c]) } };
  const mk = (k, label, score) => ({ id: `n${k}`, title: `news ${k}`, publishedAt: new Date(t0 + k * day + 3_600_000).toISOString(), tickers: [{ market: 'idx', symbol: 'BBCA' }], sentiment: { label, score } });
  // After close k the next close is k+1: up, down, up, down, up, down, down.
  const journal = [mk(0, 'bullish', 1), mk(1, 'bearish', -1), mk(2, 'bullish', 1), mk(3, 'bullish', 1), mk(4, 'bullish', 1), mk(6, 'bearish', -1)];
  const { items, tickers } = correlateNews(journal, history, {}, { nowMs: t0 + 8 * day });
  assert.equal(items[0].tickers[0].reaction.nextDayPct, 2);
  const agg = tickers.find((t) => t.symbol === 'BBCA');
  assert.equal(agg.count, 6);
  assert.equal(agg.measured, 6);
  assert.equal(agg.toneMatchedMovePct, 83); // 5 of 6 matched
  assert.ok(agg.toneMoveCorrelation > 0.5);
  assert.deepEqual(priceHistoryFrom({ X: { '1d': [{ time: 0, close: 1 }] } }).X, [[86_400_000, 1]]);
});

function bars(closes) {
  return closes.map((c, k) => ({ time: k * 86_400, date: `d${k}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }));
}

test('scanner flags the day-trader-skill daily setups', () => {
  const flat = Array.from({ length: 40 }, (_, k) => 100 + (k % 3));
  assert.ok(scanSetups(bars([...flat, 110])).setups.includes('breakout20'));
  const falling = Array.from({ length: 40 }, (_, k) => 100 - k * 1.5);
  const fall = scanSetups(bars(falling));
  assert.ok(fall.setups.includes('oversold'));
  assert.ok(scanSetups(bars([...falling, falling.at(-1) + 0.5])).setups.includes('oversoldBounce'));
  const flag = [...Array.from({ length: 30 }, () => 100), 100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 121, 120.5, 121, 120.8, 121.2];
  assert.ok(scanSetups(bars(flag)).setups.includes('bullFlag'));
  assert.equal(scanSetups(bars([1, 2, 3])), null);
  const hits = runScanner({ A: { '1d': bars([...flat, 110]) }, B: { '1d': bars(flat) } }, { minValue: 0 });
  assert.deepEqual(hits.map((h) => h.symbol), ['A']);
});

test('time machine: deterministic odds, uptrending history leans to the target', () => {
  const up = [];
  let p = 100;
  for (let k = 0; k < 300; k += 1) { const o = p; p *= 1 + 0.004 + ((k * 7919) % 13 - 6) / 600; up.push({ open: o, high: Math.max(o, p) * 1.005, low: Math.min(o, p) * 0.995, close: p }); }
  const a = timeMachine({ daily: up, price: 100, stop: 90, target: 110, horizonDays: 30 });
  const b = timeMachine({ daily: up, price: 100, stop: 90, target: 110, horizonDays: 30 });
  assert.deepEqual(a, b);
  assert.ok(a.pTarget > a.pStop);
  assert.match(a.label, /target/);
  assert.equal(a.rewardRisk, 1);
  assert.equal(timeMachine({ daily: up, price: 100, stop: 101, target: 110 }), null);
  assert.equal(timeMachine({ daily: up.slice(0, 20), price: 100, stop: 90, target: 110 }), null);
});
