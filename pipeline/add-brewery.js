/* Manual one-off CLI: add a hand-reported brewery (missing from Open
   Brewery DB) to the git-tracked seed file, geocoding the city via
   Open-Meteo. Everyone else's submissions go through the app's
   "Missing a brewery?" form -> Firestore -> pipeline/sync-brewery-
   requests.js instead; this is for typing one in yourself from the
   terminal.

   Usage: node pipeline/add-brewery.js "Brewery Name" "City, State" <website>

   Prints the added entry as JSON on success; exits 0 with "already
   present" if the id exists. Exit 1 = missing args or couldn't geocode. */

const fs = require('fs');
const path = require('path');
const { slug, geocode } = require('./brewery-lib');

const SEED = path.join(__dirname, 'extra-breweries.seed.json');

async function main() {
  let [name, cityRaw, website] = process.argv.slice(2);
  if (!name || !cityRaw || !website) {
    console.error(
      'need a brewery name, a "City, State", AND a website — ' +
        'the website is what the nightly tap-list scan reads'
    );
    process.exit(1);
  }
  if (!/^https?:\/\//i.test(website)) website = `https://${website}`;

  const geo = await geocode(cityRaw);
  const entry = {
    id: `x-${slug(name)}-${slug(geo.city)}`,
    name,
    city: geo.city,
    state: geo.state,
    lat: Math.round(geo.lat * 1e4) / 1e4,
    lng: Math.round(geo.lng * 1e4) / 1e4,
    website_url: website,
  };

  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  if (seed.some((e) => e.id === entry.id)) {
    console.log(`already present: ${entry.id}`);
    return;
  }
  seed.push(entry);
  fs.writeFileSync(SEED, JSON.stringify(seed, null, 2) + '\n');
  console.log(JSON.stringify(entry, null, 2));
  console.log('Run pipeline/sync-brewery-requests.js (or just push — the');
  console.log('next "Refresh tap data (fast)" run will pick it up) to');
  console.log('publish this into extra-breweries.json.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
