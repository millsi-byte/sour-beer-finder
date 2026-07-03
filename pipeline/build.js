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

  for (const src of sources) {
    const adapter = adapters[src.source];
    if (!adapter) {
      console.warn(`skip ${src.name}: unknown source "${src.source}"`);
      continue;
    }
    try {
      const beers = await adapter(src, process.env);
      if (beers == null) {
        console.warn(`skip ${src.name}: ${src.source} adapter not configured`);
        continue;
      }
      const sours = beers.filter((b) => isSourStyle(b.style));
      out.breweries[src.obdb_id] = {
        source: src.source,
        fetched_at: new Date().toISOString(),
        beer_count: beers.length,
        sours: sours.map(({ name, style }) => ({ name, style })),
      };
      console.log(`${src.name}: ${beers.length} beers, ${sours.length} sours (${src.source})`);
    } catch (e) {
      console.warn(`skip ${src.name}: ${e.message}`);
    }
  }

  const outPath = path.join(__dirname, '..', 'data', 'taps.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote data/taps.json — ${Object.keys(out.breweries).length} breweries`);
  await require('./browser').closeBrowser();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
