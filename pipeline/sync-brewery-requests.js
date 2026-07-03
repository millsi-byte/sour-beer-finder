/* Pulls every "Missing a brewery?" submission out of Firestore
   (collection `brewery_requests`, written by the app's crowd.js ->
   submitBreweryRequest) and regenerates pipeline/extra-breweries.json
   from scratch: seed file (hand-added entries) + every non-duplicate
   request, geocoded fresh each run.

   Regenerating instead of incrementally appending means deleting a bad
   submission is ONE action (delete the Firestore doc in the Firebase
   console) — there's no second, stale copy left behind in git the way
   an append-only file would leave.

   Run as a step in refresh-data.yml, right before pipeline/build.js
   (which re-reads extra-breweries.json and republishes it into
   data/taps.json — this script never touches taps.json directly).
   Skips cleanly (exit 0) if Firebase hasn't been configured yet. */

const fs = require('fs');
const path = require('path');
const { slug, geocode, haversineMiles, namesLikelyMatch } = require('./brewery-lib');

const CONFIG = path.join(__dirname, '..', 'data', 'crowd-config.json');
const SEED = path.join(__dirname, 'extra-breweries.seed.json');
const OUT = path.join(__dirname, 'extra-breweries.json');

const DUPE_MILES = 1; // tight on purpose — see brewery-lib.js namesLikelyMatch

function isDuplicate(candidate, corpus) {
  return corpus.find(
    (e) =>
      e.id === candidate.id ||
      (haversineMiles(e, candidate) <= DUPE_MILES && namesLikelyMatch(e.name, candidate.name))
  );
}

async function fetchRequests(cfg) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${cfg.project_id}` +
    `/databases/(default)/documents:runQuery?key=${cfg.api_key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'brewery_requests' }],
        orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'ASCENDING' }],
        limit: 1000,
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore query ${res.status}`);
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => {
      const f = r.document.fields ?? {};
      return {
        docId: r.document.name.split('/').pop(),
        name: f.name?.stringValue ?? '',
        city: f.city?.stringValue ?? '',
        website_url: f.website_url?.stringValue ?? '',
      };
    });
}

async function main() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    console.log('data/crowd-config.json not present — skipping brewery-request sync');
    return;
  }
  if (!cfg.project_id || !cfg.api_key) {
    console.log('crowd-config.json missing project_id/api_key — skipping');
    return;
  }

  const corpus = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const requests = await fetchRequests(cfg);
  console.log(`${requests.length} brewery request(s) in Firestore`);

  let added = 0;
  let skipped = 0;
  for (const req of requests) {
    if (!req.name || !req.city || !req.website_url) {
      console.warn(`  skip ${req.docId}: missing name/city/website (bad submission)`);
      skipped++;
      continue;
    }
    let geo;
    try {
      geo = await geocode(req.city);
    } catch (e) {
      console.warn(`  skip ${req.docId} ("${req.name}", "${req.city}"): ${e.message} — will retry next run`);
      skipped++;
      continue;
    }
    const candidate = {
      id: `x-${slug(req.name)}-${slug(geo.city)}`,
      name: req.name,
      city: geo.city,
      state: geo.state,
      lat: Math.round(geo.lat * 1e4) / 1e4,
      lng: Math.round(geo.lng * 1e4) / 1e4,
      website_url: req.website_url,
    };
    const dupe = isDuplicate(candidate, corpus);
    if (dupe) {
      const miles = haversineMiles(dupe, candidate).toFixed(1);
      console.log(
        `  possible duplicate skipped: "${req.name}" (${req.city}) looks like ` +
          `existing "${dupe.name}" (${dupe.city}, ${miles}mi away) — the Firestore ` +
          `doc is untouched; delete it or rename to disambiguate if this is wrong`
      );
      skipped++;
      continue;
    }
    corpus.push(candidate);
    added++;
    console.log(`  added: ${candidate.name} (${candidate.city}, ${candidate.state})`);
  }

  fs.writeFileSync(OUT, JSON.stringify(corpus, null, 2) + '\n');
  console.log(`wrote extra-breweries.json — ${corpus.length} entries (${added} new, ${skipped} skipped)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, isDuplicate };
