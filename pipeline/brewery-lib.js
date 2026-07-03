/* Shared helpers for anything that turns a free-text "brewery name +
   city" into a structured, geolocated extra-breweries entry: the manual
   CLI (add-brewery.js) and the Firestore sync script
   (sync-brewery-requests.js) both use this — one geocoder, one slug
   scheme, one duplicate-detection heuristic. */

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

/* Node port of app.js's haversineMiles — can't require() a plain
   <script>-tag browser file, so this is a second copy (same precedent
   as STATE_ABBR already existing twice: once here, once client-side). */
function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const FILLER_WORDS = /\b(brewing|brewery|breweries|company|co|llc|inc|taproom)\b/g;

/* Same normalization on both sides of the wire (client copy lives in
   app.js) so "Tree House Brewing Co" and "Tree House Brewing Company"
   collide but "Tree House" (Charlton) and "Tree House Tewksbury" don't
   get conflated with an unrelated "Treehouse Taproom" across town. */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(FILLER_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Tight AND-gate: within ~1mi (haversineMiles) AND the normalized names
   overlap (one contains the other, or they share the majority of their
   significant tokens). Distance is what separates Tree House's two real
   locations (~40mi apart, near-identical names) from an actual
   duplicate — never treat two same-named places as one dupe just
   because they're close; both conditions must hold. */
function namesLikelyMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false; // nothing left after stripping filler words
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}

module.exports = { STATE_ABBR, slug, geocode, haversineMiles, normalizeName, namesLikelyMatch };
