// Minimal RSS 2.0 / Atom reader: enough for Google News, CNBC Indonesia,
// CoinDesk and Cointelegraph feeds. No dependencies; feed text is untrusted,
// so every field is plain-text decoded and length-capped, never rendered as HTML.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeText(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // Descriptions often carry HTML: drop the tags (decoded entities can form tags too).
  s = s.replace(/<[^>]*>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}

function attr(block, name, attribute) {
  const m = block.match(new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function safeUrl(value) {
  try {
    const url = new URL(decodeText(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

export function parseFeed(xml, { maxItems = 60 } = {}) {
  const text = String(xml || '');
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const items = [];
  for (const block of blocks.slice(0, maxItems)) {
    let title = decodeText(tag(block, 'title')).slice(0, 300);
    let source = decodeText(tag(block, 'source')).slice(0, 80) || null;
    // Google News appends " - Source" to every title.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = safeUrl(tag(block, 'link') || attr(block, 'link', 'href') || '');
    const published = Date.parse(decodeText(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date') || ''));
    const summary = decodeText(tag(block, 'description') || tag(block, 'summary') || '').slice(0, 400);
    if (!title || !link) continue;
    items.push({ title, link, source, summary, publishedMs: Number.isFinite(published) ? published : null });
  }
  return items;
}
