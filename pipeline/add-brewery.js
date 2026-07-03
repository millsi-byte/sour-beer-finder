/* Adds a hand-reported brewery (missing from Open Brewery DB) to
   pipeline/extra-breweries.json, geocoding the city via Open-Meteo,
   and mirrors the list into data/taps.json so the app sees it on the
   very next deploy (no build.js run needed).

   Usage:
     node pipeline/add-brewery.js "Brewery Name" "City, State" [website]
     ISSUE_BODY="Name: ...\nCity: ...\nWebsite: ..." node pipeline/add-brewery.js --from-issue

   Prints the added entry as JSON on success; exits 0 with "already present"
   if the id exists. Exit 1 = couldn't parse or geocode (workflow comments
   the failure back on the issue). */

const fs = require('fs');
const path = require('path');

const EXTRAS = path.join(__dirname, 'extra-breweries.json');
const TAPS = path.join(__dirname, '..', 'data', 'taps.json');

const STATE_ABBR = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming', DC: 'District of Columbia',
};

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseIssue(body) {
  const grab = (label) =>
    body.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'))?.[1].trim() ?? '';
  return { name: grab('Name'), city: grab('City'), website: grab('Website') };
}

async function geocode(cityRaw) {
  const [city, stRaw] = cityRaw.split(',').map((s) => s.trim());
  const wantState =
    stRaw && (STATE_ABBR[stRaw.toUpperCase()] || stRaw).toLowerCase();
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=' +
    encodeURIComponent(city);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoder ${res.status}`);
  const hits = ((await res.json()).results || []).filter(
    (r) => r.country_code === 'US'
  );
  const match = wantState
    ? hits.find((r) => (r.admin1 || '').toLowerCase() === wantState)
    : hits[0];
  if (!match) throw new Error(`no US geocoder match for "${cityRaw}"`);
  return { city: match.name, state: match.admin1, lat: match.latitude, lng: match.longitude };
}

async function main() {
  let name, cityRaw, website;
  if (process.argv[2] === '--from-issue') {
    ({ name, city: cityRaw, website } = parseIssue(process.env.ISSUE_BODY || ''));
  } else {
    [name, cityRaw, website] = process.argv.slice(2);
  }
  if (!name || !cityRaw) {
    console.error('need a brewery name and a "City, State"');
    process.exit(1);
  }
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

  const geo = await geocode(cityRaw);
  const entry = {
    id: `x-${slug(name)}-${slug(geo.city)}`,
    name,
    city: geo.city,
    state: geo.state,
    lat: Math.round(geo.lat * 1e4) / 1e4,
    lng: Math.round(geo.lng * 1e4) / 1e4,
    ...(website && { website_url: website }),
  };

  const extras = JSON.parse(fs.readFileSync(EXTRAS, 'utf8'));
  if (extras.some((e) => e.id === entry.id)) {
    console.log(`already present: ${entry.id}`);
    return;
  }
  extras.push(entry);
  fs.writeFileSync(EXTRAS, JSON.stringify(extras, null, 2) + '\n');

  // mirror into the published snapshot so the app shows it immediately
  try {
    const taps = JSON.parse(fs.readFileSync(TAPS, 'utf8'));
    taps.extra_breweries = extras;
    fs.writeFileSync(TAPS, JSON.stringify(taps, null, 2) + '\n');
  } catch {
    /* no snapshot yet — build.js will publish it */
  }

  console.log(JSON.stringify(entry, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
