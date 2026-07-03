/* Nightly tap-list builder: runs one adapter per sources.json entry,
   filters sour styles, and writes data/taps.json for the app to read.
   Zero dependencies — plain Node 20+. Run: node pipeline/build.js */

const fs = require('fs');
const path = require('path');
const adapters = require('./adapters');
const { isSourStyle } = require('./normalize');

async function main() {
  const sources = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8')
  );
  const areas = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'areas.json'), 'utf8')
  );
  // hand-added breweries that Open Brewery DB is missing (Tree House!) —
  // published to the app so they appear in search results like any other
  const extras = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'extra-breweries.json'), 'utf8')
  );
  const out = {
    generated_at: new Date().toISOString(),
    areas: areas.map(({ label, center }) => ({ label, center })),
    extra_breweries: extras,
    breweries: {},
  };

  const outPath = path.join(__dirname, '..', 'data', 'taps.json');
  // last snapshot: an empty or failed read usually means the source
  // throttled the runner's IP (Untappd cuts embeds off a few minutes
  // into every run), not that the taproom went dry — keep the previous
  // menu (with its older fetched_at) rather than wiping real data
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(outPath, 'utf8')).breweries || {};
  } catch {
    /* first run */
  }

  // shuffle: whoever sits late in the list lands in the throttle window,
  // so rotate the order — across runs everyone gets a fresh read
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }

  let kept = 0;
  const keepPrev = (src, why) => {
    if (prev[src.obdb_id]?.beer_count > 0) {
      out.breweries[src.obdb_id] = prev[src.obdb_id];
      kept++;
      console.log(`${src.name}: ${why} — kept previous ${prev[src.obdb_id].beer_count} beers (${src.source})`);
      return true;
    }
    return false;
  };

  for (const src of sources) {
    const adapter = adapters[src.source];
    if (!adapter) {
      console.warn(`skip ${src.name}: unknown source "${src.source}"`);
      continue;
    }
    try {
      const beers = await adapter(src, process.env);
      if (beers == null) {
        if (!keepPrev(src, 'adapter not configured')) {
          console.warn(`skip ${src.name}: ${src.source} adapter not configured`);
        }
        continue;
      }
      if (!beers.length && keepPrev(src, 'empty read')) continue;
      const sours = beers.filter((b) => isSourStyle(b.style));
      out.breweries[src.obdb_id] = {
        name: src.name, // display name for the app's Beers catalog
        source: src.source,
        fetched_at: new Date().toISOString(),
        beer_count: beers.length,
        sours: sours.map(({ name, style }) => ({ name, style })),
      };
      console.log(`${src.name}: ${beers.length} beers, ${sours.length} sours (${src.source})`);
    } catch (e) {
      if (!keepPrev(src, `error (${e.message})`)) {
        console.warn(`skip ${src.name}: ${e.message}`);
      }
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(
    `wrote data/taps.json — ${Object.keys(out.breweries).length} breweries (${kept} kept from previous run)`
  );
  await require('./browser').closeBrowser();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
