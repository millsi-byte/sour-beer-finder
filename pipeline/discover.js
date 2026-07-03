/* Widget detection — the clever unlock. Open Brewery DB already gives each
   brewery's website; fetch its homepage (and its menu/tap-list subpages)
   and look for the telltale tap-list embed signatures, then write the
   discovered mappings into sources.json automatically instead of
   maintaining them by hand.

   Areas live in areas.json — the managed list of places scanned nightly.

   Usage:
     node pipeline/discover.js --all                       # every area in areas.json
     node pipeline/discover.js "28.54,-81.38" "Orlando, FL" # one area (persisted to areas.json)
     node pipeline/discover.js "Tampa, Florida"             # by city + full state name

   Existing sources.json entries are never overwritten. */

const fs = require('fs');
const path = require('path');
const { fetchText } = require('./lib');

const OBDB = 'https://api.openbrewerydb.org/v1/breweries';
const SOURCES = path.join(__dirname, 'sources.json');
const AREAS = path.join(__dirname, 'areas.json');

/* signature -> sources.json entry fields. First match wins (Untappd is the
   anchor source, so it's checked first). */
const SIGNATURES = [
  {
    source: 'untappd',
    detect: (html) => {
      const m =
        html.match(/business\.untappd\.com\/(?:embeds\/)?locations\/(\d+)/) ??
        html.match(/business\.untappd\.com\/(?:api\/)?v\d\/locations\/(\d+)/);
      return m && { untappd_location_id: Number(m[1]) };
    },
  },
  {
    source: 'beermenus',
    detect: (html) => {
      const m = html.match(/beermenus\.com\/(?:widget\/)?places\/([a-z0-9-]+)/i);
      return m && { beermenus_slug: m[1] };
    },
  },
  {
    source: 'taplist',
    detect: (html) => {
      const m = html.match(/https?:\/\/[^"'\s>]*taplist\.io[^"'\s>]*/i);
      return m && { embed_url: m[0] };
    },
  },
  {
    source: 'digitalpour',
    detect: (html) => {
      const m = html.match(/https?:\/\/[^"'\s>]*digitalpour\.com[^"'\s>]*/i);
      return m && { embed_url: m[0] };
    },
  },
];

function detect(html) {
  for (const sig of SIGNATURES) {
    const fields = sig.detect(html);
    if (fields) return { source: sig.source, ...fields };
  }
  return null;
}

/* Same-host links that look like a menu/tap-list page — widgets usually
   live there, not on the homepage. */
function menuLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = new Set();
  for (const [, href] of html.matchAll(/href="([^"#]+)"/gi)) {
    if (!/menu|tap|beer|drink|pour|brew/i.test(href)) continue;
    if (/\.(pdf|jpe?g|png|webp)($|\?)|mailto:|tel:/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.host === base.host && u.href !== base.href) out.add(u.href);
    } catch {
      /* bad href */
    }
  }
  return [...out].slice(0, 3);
}

async function scanSite(websiteUrl) {
  const html = await fetchText(websiteUrl, { timeoutMs: 10000 });
  let hit = detect(html);
  if (hit) return hit;
  for (const link of menuLinks(html, websiteUrl)) {
    try {
      hit = detect(await fetchText(link, { timeoutMs: 8000 }));
      if (hit) return hit;
    } catch {
      /* subpage unreachable — keep trying the rest */
    }
  }
  return null;
}

async function fetchBreweries(center) {
  const params = new URLSearchParams({ per_page: '200' });
  const coords = center.match(/^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/);
  if (coords) params.set('by_dist', `${coords[1]},${coords[2]}`);
  else {
    const [city, state] = center.split(',').map((s) => s.trim());
    params.set('by_city', city);
    if (state) params.set('by_state', state); // OBDB wants the full state name
  }
  const res = await fetch(`${OBDB}?${params}`);
  if (!res.ok) throw new Error(`Open Brewery DB ${res.status}`);
  return res.json();
}

async function discoverArea(center, sources, known) {
  const breweries = (await fetchBreweries(center)).filter((b) => b.website_url);
  console.log(`${breweries.length} breweries with websites near "${center}"`);
  let found = 0;
  const queue = [...breweries];
  const workers = Array.from({ length: 5 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      if (known.has(b.id)) continue;
      try {
        const hit = await scanSite(b.website_url);
        if (hit) {
          sources.push({ obdb_id: b.id, name: b.name, ...hit });
          known.add(b.id);
          found++;
          console.log(`  ${b.name}: ${hit.source}`);
        }
      } catch (e) {
        console.warn(`  ${b.name}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  return found;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node pipeline/discover.js --all | "<center>" ["<label>"]');
    process.exit(1);
  }
  const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const known = new Set(sources.map((s) => s.obdb_id));
  const areas = JSON.parse(fs.readFileSync(AREAS, 'utf8'));

  let found = 0;
  if (arg === '--all') {
    for (const a of areas) found += await discoverArea(a.center, sources, known);
  } else {
    // ad-hoc area: persist it so nightly scans keep covering it
    if (!areas.some((a) => a.center === arg)) {
      areas.push({ label: process.argv[3] || arg, center: arg });
      fs.writeFileSync(AREAS, JSON.stringify(areas, null, 2) + '\n');
      console.log(`added "${process.argv[3] || arg}" to areas.json`);
    }
    found = await discoverArea(arg, sources, known);
  }

  fs.writeFileSync(SOURCES, JSON.stringify(sources, null, 2) + '\n');
  console.log(`discovered ${found} new sources — sources.json now has ${sources.length} entries`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { detect, menuLinks };
