/* Shared helpers for adapters and discovery: polite fetching (identified
   user-agent, timeout), a minimal robots.txt check, and a generic
   beer extractor for JSON embeds. Zero dependencies. */

/* Crawler-standard UA: transparent about being a bot but in the
   Mozilla-compatible format WAFs expect — the bare "S4S-taplist-bot" UA
   was 403'd by most Squarespace/Wix/Cloudflare-fronted brewery sites. */
const USER_AGENT =
  'Mozilla/5.0 (compatible; S4S-bot/1.0; +https://github.com/millsi-byte/sour-beer-finder)';

async function fetchText(url, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} on ${url}`);
    return res.text();
  } finally {
    clearTimeout(t);
  }
}

/* True when the site's robots.txt disallows `path` for all agents.
   Deliberately simple: only the `User-agent: *` block, prefix matching. */
async function robotsDisallows(origin, path) {
  let txt;
  try {
    txt = await fetchText(`${origin}/robots.txt`, { timeoutMs: 6000 });
  } catch {
    return false; // no robots.txt (or unreachable) — assume allowed
  }
  let inStar = false;
  for (const raw of txt.split('\n')) {
    const line = raw.split('#')[0].trim();
    const m = line.match(/^(user-agent|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = m;
    if (key.toLowerCase() === 'user-agent') inStar = val.trim() === '*';
    else if (inStar && val && path.startsWith(val.trim())) return true;
  }
  return false;
}

/* Walk any JSON structure and collect objects that look like beers.
   Different embeds nest differently; this finds {name, style}-ish pairs
   wherever they live. Matched nodes aren't recursed into (no dupes). */
function collectBeers(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectBeers(n, out));
  } else if (node && typeof node === 'object') {
    const bev = node.beverage && typeof node.beverage === 'object' ? node.beverage : node;
    const name = bev.name ?? bev.beer_name ?? bev.beverage_name;
    let style = bev.style ?? bev.beer_style ?? bev.style_name;
    if (style && typeof style === 'object') {
      style = typeof style.name === 'string' ? style.name : '';
    }
    if (typeof name === 'string' && name && style != null) {
      out.push({ name: name.trim(), style: String(style).trim() });
    } else {
      Object.values(node).forEach((v) => collectBeers(v, out));
    }
  }
  return out;
}

/* Pull every JSON blob out of an HTML page (script bodies and inline
   assignments) and run collectBeers over anything that parses. */
function beersFromEmbeddedJson(html) {
  const beers = [];
  const scripts = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of scripts) {
    const start = body.indexOf('{');
    const startArr = body.indexOf('[');
    const i = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    if (i === -1) continue;
    for (let end = body.length; end > i; end = body.lastIndexOf('}', end - 1)) {
      try {
        collectBeers(JSON.parse(body.slice(i, end + 1)), beers);
        break;
      } catch {
        /* keep shrinking */
      }
      if (end <= i + 1) break;
    }
  }
  return beers;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#038': '&' };
function decodeEntities(s) {
  return s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

module.exports = { USER_AGENT, fetchText, robotsDisallows, collectBeers, beersFromEmbeddedJson, decodeEntities };
