/* Widget detection — the clever unlock. Open Brewery DB already gives each
   brewery's website; fetch each homepage once and look for the telltale
   tap-list embed signatures, then write the discovered mappings into
   sources.json automatically instead of maintaining them by hand.

   Usage:
     node pipeline/discover.js "Tampa"            # by city
     node pipeline/discover.js "Tampa, Florida"   # by city + full state name
     node pipeline/discover.js "27.95,-82.45"     # by lat,lng (closest 200)

   Existing sources.json entries are never overwritten. */

const fs = require('fs');
const path = require('path');
const { fetchText } = require('./lib');

const OBDB = 'https://api.openbrewerydb.org/v1/breweries';
const SOURCES = path.join(__dirname, 'sources.json');

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

async function fetchBreweries(area) {
  const params = new URLSearchParams({ per_page: '200' });
  const coords = area.match(/^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/);
  if (coords) params.set('by_dist', `${coords[1]},${coords[2]}`);
  else {
    const [city, state] = area.split(',').map((s) => s.trim());
    params.set('by_city', city);
    if (state) params.set('by_state', state); // OBDB wants the full state name
  }
  const res = await fetch(`${OBDB}?${params}`);
  if (!res.ok) throw new Error(`Open Brewery DB ${res.status}`);
  return res.json();
}

function detect(html) {
  for (const sig of SIGNATURES) {
    const fields = sig.detect(html);
    if (fields) return { source: sig.source, ...fields };
  }
  return null;
}

async function main() {
  const area = process.argv[2];
  if (!area) {
    console.error('usage: node pipeline/discover.js "City[, Full State Name]" | "lat,lng"');
    process.exit(1);
  }
  const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const known = new Set(sources.map((s) => s.obdb_id));

  const breweries = (await fetchBreweries(area)).filter((b) => b.website_url);
  console.log(`${breweries.length} breweries with websites in "${area}"`);

  let found = 0;
  const queue = [...breweries];
  const workers = Array.from({ length: 5 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      if (known.has(b.id)) continue;
      try {
        const html = await fetchText(b.website_url, { timeoutMs: 8000 });
        const hit = detect(html);
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

  fs.writeFileSync(SOURCES, JSON.stringify(sources, null, 2) + '\n');
  console.log(`discovered ${found} new sources — sources.json now has ${sources.length} entries`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { detect };
