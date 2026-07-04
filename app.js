/* Search 4 Sour Beer (S4S) — nearby breweries via Open Brewery DB, plus live
   sour-on-tap data from data/taps.json (built nightly by pipeline/build.js,
   one adapter per tap-list source — see README roadmap). */

const API = 'https://api.openbrewerydb.org/v1/breweries';
// 'planning' breweries are real, named, geocoded entries (just pre-opening)
// so they stay visible — hiding them made them unsearchable while the
// distance-based duplicate check still found them, a confusing mismatch.
// 'closed' stays hidden everywhere.
const HIDDEN_TYPES = new Set(['closed']);

const $ = (id) => document.getElementById(id);
const state = { origin: null, breweries: [], taps: null, crowdCounts: {} };

// bump on every release — shown under Check for updates on the Cities page
const APP_BUILD = '2026.07.04.10';

// drinker-report badge counts (crowd.js) — cheap, loads once in the
// background; re-render whenever they arrive after the list is up
crowd.crowdCounts().then((c) => {
  state.crowdCounts = c;
  if (state.view === 'list') renderList();
});

/* Re-derive the 👥-on-tap counts after any vote/report — crowd.js's own
   cache already has the new doc (createDoc pushes it there), so this is
   a local recompute, not a network round trip. Without this, a beer
   marked gone stays counted "on tap" in the results filter/badges until
   the page is reloaded. */
async function refreshCrowdCounts() {
  state.crowdCounts = await crowd.crowdCounts();
  if (state.view === 'list') renderList();
  refreshCurrentTabMarks();
}

// profile pill appears once crowd features are configured
crowd.crowdEnabled().then((enabled) => {
  $('profilePill').hidden = !enabled;
  renderProfilePill();
});

// ---------- tap data ----------
// cache:'reload' = always hit the network; the service worker still keeps
// an offline fallback copy
const tapsReady = fetch('data/taps.json', { cache: 'reload' })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { state.taps = d; })
  .catch(() => {});

function tapInfo(b) {
  return state.taps?.breweries?.[b.id] ?? null;
}

const SOURCE_LABELS = {
  untappd: 'via Untappd',
  arryved: 'via Arryved',
  beermenus: 'via BeerMenus',
  taplist: 'via Taplist.io',
  digitalpour: 'via DigitalPour',
  manual: 'reported manually',
};

function fmtAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// ---------- city autocomplete (Open-Meteo geocoder: free, keyless) ----------
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI',
  Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
  Wisconsin: 'WI', Wyoming: 'WY',
};

async function geocodeCities(raw) {
  const [city, st] = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!city) return [];
  try {
    const res = await fetch(`${GEO}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`);
    if (!res.ok) return [];
    let hits = ((await res.json()).results ?? []).filter((r) => r.country_code === 'US');
    if (st) {
      hits = hits.filter(
        (r) =>
          STATE_ABBR[r.admin1] === st.toUpperCase() ||
          (r.admin1 ?? '').toLowerCase() === st.toLowerCase()
      );
    }
    return hits.slice(0, 6).map((r) => ({
      label: r.admin1 ? `${r.name}, ${STATE_ABBR[r.admin1] ?? r.admin1}` : r.name,
      lat: r.latitude,
      lng: r.longitude,
    }));
  } catch {
    return [];
  }
}

/* Registers a tap (not drag/scroll) handler on el. Plain pointerdown+
   preventDefault treats every touch as a selection, which cancels the
   browser's native scroll gesture — so a finger-drag to scroll a long
   list instead immediately "selects" whatever was under the start
   point. Tracking movement between pointerdown/pointerup lets a real
   drag scroll normally while a stationary tap still fires instantly. */
function onTap(el, handler) {
  let sx = 0, sy = 0, dragging = false;
  el.addEventListener('pointerdown', (e) => {
    sx = e.clientX;
    sy = e.clientY;
    dragging = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) dragging = true;
  });
  el.addEventListener('pointerup', (e) => {
    if (!dragging) handler(e);
  });
}

/* Dropdown of matching cities under `input`; onPick gets {label, lat, lng}.
   Returns {first} so submit handlers can take the top suggestion. */
function attachCityAutocomplete(input, onPick) {
  const list = document.createElement('ul');
  list.className = 'suggest';
  list.hidden = true;
  input.parentElement.appendChild(list);
  let timer = 0;
  let current = [];
  const close = () => {
    list.hidden = true;
    list.innerHTML = '';
    current = [];
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      current = await geocodeCities(q);
      if (document.activeElement !== input) return close();
      list.innerHTML = '';
      current.forEach((c) => {
        const li = document.createElement('li');
        li.textContent = c.label;
        onTap(li, () => {
          input.value = '';
          close();
          onPick(c);
        });
        list.appendChild(li);
      });
      list.hidden = !current.length;
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(close, 200));
  return { first: () => current[0] ?? null, close };
}

// ---------- saved cities (this device only) ----------
const CITIES_KEY = 's4s.cities';

function loadSavedCities() {
  try {
    return JSON.parse(localStorage.getItem(CITIES_KEY)) ?? [];
  } catch {
    return [];
  }
}

/* Stable cloud key for a saved location: coords when we have them
   (4 decimals ≈ 11m), name otherwise. */
function locKey(c) {
  return c.lat != null
    ? `loc:${(+c.lat).toFixed(4)},${(+c.lng).toFixed(4)}`
    : `loc:${c.q.trim().toLowerCase()}`;
}

function saveSavedCities(cities) {
  const before = loadSavedCities();
  localStorage.setItem(CITIES_KEY, JSON.stringify(cities));
  // signed in → mirror adds/removes to the cloud as append-only fav
  // events (setFav is idempotent, so replays can't flip other devices);
  // fire-and-forget: localStorage stays the offline-readable copy
  if (!crowd.authState()) return;
  const beforeKeys = new Set(before.map(locKey));
  const afterKeys = new Set(cities.map(locKey));
  for (const c of cities) {
    if (!beforeKeys.has(locKey(c))) {
      crowd.setFav('location', locKey(c), true, {
        label: c.q,
        lat: c.lat != null ? String(c.lat) : undefined,
        lng: c.lng != null ? String(c.lng) : undefined,
      }).catch(() => {});
    }
  }
  for (const c of before) {
    if (!afterKeys.has(locKey(c))) {
      crowd.setFav('location', locKey(c), false, { label: c.q }).catch(() => {});
    }
  }
}

/* On sign-in (or app start while signed in): pull cloud location favs
   into the local list, and push local-only ones up. Union only — a
   remove is only ever an explicit user action, never a sync side-effect. */
async function syncLocationFavs() {
  if (!crowd.authState()) return;
  try {
    const { favs } = await crowd.myMarks();
    const cities = loadSavedCities();
    const localKeys = new Set(cities.map(locKey));
    let changed = false;
    for (const e of favs.values()) {
      if (e.target_type !== 'location' || localKeys.has(e.target_key)) continue;
      if (!e.label) continue;
      cities.push({
        q: e.label,
        lat: e.lat != null ? +e.lat : undefined,
        lng: e.lng != null ? +e.lng : undefined,
        home: false,
      });
      changed = true;
    }
    for (const c of cities) {
      if (!favs.has(`location|${locKey(c)}`)) {
        crowd.setFav('location', locKey(c), true, {
          label: c.q,
          lat: c.lat != null ? String(c.lat) : undefined,
          lng: c.lng != null ? String(c.lng) : undefined,
        }).catch(() => {});
      }
    }
    if (changed) {
      localStorage.setItem(CITIES_KEY, JSON.stringify(cities));
      renderCityDrop();
      if (state.view === 'cities') renderCities();
    }
  } catch {
    /* offline — next session syncs */
  }
}
window.addEventListener('s4s:authchange', () => {
  crowd.clearMarksCache();
  if (crowd.authState()) syncLocationFavs();
});
if (crowd.authState?.()) setTimeout(syncLocationFavs, 800);

/* taps.json `areas` entries are {label, center} (older snapshots: strings) */
function areaObjects() {
  return (state.taps?.areas ?? []).map((a) =>
    typeof a === 'string' ? { label: a } : a
  );
}

function isCovered(city) {
  return areaObjects().some((a) => {
    const m = (a.center ?? '').match(/(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
    if (m && city.lat != null) {
      return (
        haversineMiles({ lat: city.lat, lng: city.lng }, { lat: +m[1], lng: +m[2] }) < 60
      );
    }
    return (
      a.label.split(',')[0].trim().toLowerCase() ===
      city.q.split(',')[0].trim().toLowerCase()
    );
  });
}

// ---------- geo helpers ----------
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

function fmtMiles(mi) {
  if (mi == null) return '';
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

// ---------- data ----------
async function fetchByDist(lat, lng) {
  const res = await fetch(`${API}?by_dist=${lat},${lng}&per_page=200`);
  if (!res.ok) throw new Error(`Open Brewery DB error ${res.status}`);
  return res.json();
}

async function fetchByCity(city, stateName) {
  const params = new URLSearchParams({ by_city: city, per_page: '200' });
  if (stateName) params.set('by_state', stateName);
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Open Brewery DB error ${res.status}`);
  return res.json();
}

/* Same normalization/matching on both sides of the wire — the pipeline's
   copy is pipeline/brewery-lib.js's normalizeName/namesLikelyMatch, kept
   in sync by convention (no bundler to share a module between the
   browser and Node). Tight AND-gate — distance AND name — so two real,
   near-identically-named locations (Tree House Charlton vs. Tewksbury,
   ~40mi apart) are never conflated. Used both by the missing-brewery
   "did you mean X?" nudge and by relevantExtras' OBDB-collision check
   below. */
const FILLER_WORDS = /\b(brewing|brewery|breweries|company|co|llc|inc|taproom)\b/g;

function normalizeBreweryName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(FILLER_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesLikelyMatch(a, b) {
  const na = normalizeBreweryName(a);
  const nb = normalizeBreweryName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}

/* Hand-added breweries (pipeline/extra-breweries.json, published inside
   taps.json) that Open Brewery DB is missing — Tree House! Injected when
   they're near the search origin, or in the searched city. Skipped if
   OBDB starts covering the same physical brewery (fuzzy name + tight
   distance, not just an exact string match — a crowd-submitted name is
   free text, so an exact match would miss real collisions too easily). */
function relevantExtras(list, origin, cityName) {
  const extras = state.taps?.extra_breweries ?? [];
  if (!extras.length) return [];
  const isSameBrewery = (e, b) => {
    const blat = parseFloat(b.latitude);
    const blng = parseFloat(b.longitude);
    if (!Number.isFinite(blat) || !Number.isFinite(blng)) return false;
    return haversineMiles({ lat: e.lat, lng: e.lng }, { lat: blat, lng: blng }) <= 1
      && namesLikelyMatch(e.name, b.name);
  };
  return extras
    .filter((e) => !list.some((b) => isSameBrewery(e, b)))
    .filter((e) =>
      origin
        ? haversineMiles(origin, { lat: e.lat, lng: e.lng }) <= 150
        : cityName && e.city.toLowerCase() === cityName.toLowerCase()
    )
    .map((e) => ({
      id: e.id,
      name: e.name,
      brewery_type: 'micro',
      city: e.city,
      state_province: e.state,
      latitude: String(e.lat),
      longitude: String(e.lng),
      website_url: e.website_url || null,
    }));
}

function prepare(list, origin, cityName) {
  return list
    .concat(relevantExtras(list, origin, cityName))
    .filter((b) => !HIDDEN_TYPES.has(b.brewery_type))
    .map((b) => {
      const lat = parseFloat(b.latitude);
      const lng = parseFloat(b.longitude);
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
      const miles =
        origin && hasCoords ? haversineMiles(origin, { lat, lng }) : null;
      return { ...b, lat, lng, hasCoords, miles };
    })
    .sort((x, y) => (x.miles ?? Infinity) - (y.miles ?? Infinity));
}

// ---------- views + bottom nav ----------
// every view maps to the bottom-nav tab it lives under, so the active
// tab stays lit on child views (results under Search, status under
// Settings, the loading spinner keeps whatever was lit)
const TAB_FOR_VIEW = {
  locate: 'locate',
  list: 'locate',
  cities: 'cities',
  breweries: 'breweries',
  beers: 'beers',
  settings: 'settings',
  status: 'settings',
  profile: 'settings',
};

function show(view) {
  state.view = view;
  $('btnRefresh').hidden = view !== 'status'; // refresh lives on the Data Status page only
  $('viewLocate').hidden = view !== 'locate';
  $('viewList').hidden = view !== 'list';
  $('viewCities').hidden = view !== 'cities';
  $('viewBreweries').hidden = view !== 'breweries';
  $('viewBeers').hidden = view !== 'beers';
  $('viewSettings').hidden = view !== 'settings';
  $('viewStatus').hidden = view !== 'status';
  $('viewProfile').hidden = view !== 'profile';
  $('spinner').hidden = view !== 'loading';
  const tab = TAB_FOR_VIEW[view];
  if (tab) {
    document.querySelectorAll('.bottomnav .nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
  }
}

// ---------- settings: maps provider ----------
const MAPS_KEY = 's4s.maps';
const MAP_PROVIDERS = [
  ['apple', 'Apple Maps'],
  ['google', 'Google Maps'],
  ['waze', 'Waze'],
];

function directionsUrl(b) {
  const provider = localStorage.getItem(MAPS_KEY) || 'apple';
  const name = encodeURIComponent(b.name);
  const dest = b.hasCoords ? `${b.lat},${b.lng}` : null;
  if (provider === 'google') {
    return dest
      ? `https://www.google.com/maps/dir/?api=1&destination=${dest}`
      : `https://www.google.com/maps/search/?api=1&query=${name}`;
  }
  if (provider === 'waze') {
    return dest ? `https://waze.com/ul?ll=${dest}&navigate=yes` : `https://waze.com/ul?q=${name}`;
  }
  return dest
    ? `https://maps.apple.com/?daddr=${dest}&q=${name}`
    : `https://maps.apple.com/?q=${encodeURIComponent(`${b.name} ${b.city || ''}`)}`;
}

const UNTAPPD_KEY = 's4s.untappd'; // 'web' (default) | 'app'

function renderChoiceBar(barId, key, options, fallback, onChange) {
  const bar = $(barId);
  bar.innerHTML = '';
  const cur = localStorage.getItem(key) || fallback;
  for (const [id, label] of options) {
    const btn = document.createElement('button');
    btn.className = 'radius-chip' + (id === cur ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      localStorage.setItem(key, id);
      onChange?.(id);
      renderChoiceBar(barId, key, options, fallback, onChange);
    });
    bar.appendChild(btn);
  }
}

// ---------- appearance (Auto / Light / Dark) ----------
const THEME_KEY = 's4s.theme';

/* Forced themes stamp data-theme on <html> (CSS tokens follow); the
   theme-color metas are synced too so the PWA chrome matches. A tiny
   inline script in <head> applies the saved choice before first paint. */
function applyTheme(v) {
  const root = document.documentElement;
  if (v === 'light' || v === 'dark') root.dataset.theme = v;
  else delete root.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const own = (m.media || '').includes('dark') ? '#111412' : '#f7f7f4';
    m.content = v === 'dark' ? '#111412' : v === 'light' ? '#f7f7f4' : own;
  });
}
applyTheme(localStorage.getItem(THEME_KEY) || 'auto');

function renderSettingsPage() {
  renderChoiceBar(
    'themeBar', THEME_KEY,
    [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']],
    'auto', applyTheme
  );
}

function renderProfilePage() {
  renderChoiceBar('mapsBar', MAPS_KEY, MAP_PROVIDERS, 'apple');
  renderChoiceBar('untappdBar', UNTAPPD_KEY, [['web', 'Web page'], ['app', 'Untappd app']], 'web');
  renderProfile();
}

// ---------- toast (bottom, above the nav bar, auto-hides) ----------
let toastTimer = 0;
function showToast(msg) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- profile (PIN accounts — see crowd.js auth module) ----------
let authMode = 'signin'; // 'signin' | 'signup'
let pendingSignup = null; // {name, email, pin} awaiting the email-confirm step

function renderProfilePill() {
  const a = crowd.authState();
  const pill = $('profilePill');
  pill.textContent = a ? `👤 ${a.display_name}` : '👤 Sign in';
}

async function renderProfile() {
  const enabled = await crowd.crowdEnabled();
  const a = crowd.authState();
  $('profileGate').hidden = enabled;
  $('profileSignedIn').hidden = !enabled || !a;
  $('profileAuthUI').hidden = !enabled || !!a;
  if (a) {
    $('profileWho').textContent = `Signed in as ${a.display_name} (${a.email}). Your posts are signed with your name.`;
    return;
  }
  // mode chips (reuses the radius-chip look)
  const bar = $('authModeBar');
  bar.innerHTML = '';
  for (const [id, label] of [['signin', 'Sign in'], ['signup', 'New profile']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'radius-chip' + (id === authMode ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      authMode = id;
      renderProfile();
    });
    bar.appendChild(btn);
  }
  $('auName').hidden = authMode !== 'signup';
  $('authSubmit').textContent = authMode === 'signup' ? 'Create profile' : 'Sign in';
  $('authConfirm').hidden = true;
  $('authForm').hidden = false;
  $('authError').hidden = true;
  $('authNote').hidden = true;
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auEmail').value.trim();
  const pin = $('auPin').value.trim();
  const name = $('auName').value.trim();
  $('authError').hidden = true;
  $('authNote').hidden = true;
  if (!email || pin.length < 6 || (authMode === 'signup' && !name)) {
    $('authError').hidden = false;
    $('authError').textContent =
      authMode === 'signup'
        ? 'Need a display name, an email, and a PIN of at least 6 digits.'
        : 'Need your email and your PIN (6+ digits).';
    return;
  }
  if (authMode === 'signup') {
    // the email is the ONLY way back into a profile — make them look at it
    pendingSignup = { name, email, pin };
    $('authForm').hidden = true;
    $('authConfirm').hidden = false;
    $('authConfirmText').textContent =
      `Your email is your only way back into this profile if you forget your PIN — is ${email} right?`;
    return;
  }
  const btn = $('authSubmit');
  btn.disabled = true;
  try {
    await crowd.signIn(email, pin);
    $('authForm').reset();
    showToast('Signed in — welcome back!');
  } catch (err) {
    $('authError').hidden = false;
    $('authError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('authConfirmYes').addEventListener('click', async () => {
  if (!pendingSignup) return;
  const { name, email, pin } = pendingSignup;
  $('authConfirmYes').disabled = true;
  try {
    await crowd.signUp(email, pin, name);
    pendingSignup = null;
    $('authForm').reset();
    showToast(`Profile created — welcome, ${name}!`);
  } catch (err) {
    $('authConfirm').hidden = true;
    $('authForm').hidden = false;
    $('authError').hidden = false;
    $('authError').textContent = err.message;
  } finally {
    $('authConfirmYes').disabled = false;
  }
});

$('authConfirmNo').addEventListener('click', () => {
  pendingSignup = null;
  $('authConfirm').hidden = true;
  $('authForm').hidden = false;
});

$('btnForgotPin').addEventListener('click', async () => {
  const email = $('auEmail').value.trim();
  $('authError').hidden = true;
  if (!email) {
    $('authError').hidden = false;
    $('authError').textContent = 'Type your email above first, then tap "Forgot your PIN?".';
    return;
  }
  try {
    await crowd.sendPinReset(email);
  } catch {
    /* enumeration-safe: same message either way */
  }
  $('authNote').hidden = false;
  $('authNote').textContent =
    'If that address has a profile, a reset email is on the way. Open it, set a new PIN, then come back here and sign in.';
});

$('btnSignOut').addEventListener('click', () => {
  crowd.signOut();
  showToast('Signed out.');
});

$('profilePill').addEventListener('click', () => {
  renderProfilePage();
  show('profile');
});

window.addEventListener('s4s:authchange', () => {
  renderProfilePill();
  if (state.view === 'profile') renderProfile();
  if (state.view === 'breweries') breweriesFlow();
  if (state.view === 'beers') beersFlow();
});
window.addEventListener('s4s:signedout', () =>
  showToast('Signed out — sign back in with your PIN.')
);

// ---------- list controls: radius, sort, drinker-reported filter ----------
const RADII = [10, 25, 50, 100, 'All'];
const RADIUS_KEY = 's4s.radius';
const SORT_KEY = 's4s.sort'; // 'sours' (default) | 'dist'
const ONLY_KEY = 's4s.crowdOnly'; // replaced the old sours-only toggle
let radius = Number(localStorage.getItem(RADIUS_KEY)) || 'All';
let sortMode = localStorage.getItem(SORT_KEY) || 'sours';
let crowdOnly = localStorage.getItem(ONLY_KEY) === '1';

function chip(label, active, onTap) {
  const btn = document.createElement('button');
  btn.className = 'radius-chip' + (active ? ' active' : '');
  btn.textContent = label;
  btn.addEventListener('click', onTap);
  return btn;
}

function renderControls() {
  // radius lives in a compact dropdown beside the name filter
  const wrap = document.querySelector('.radius-wrap');
  wrap.hidden = !state.origin; // no distances → nothing to filter
  if (!wrap.hidden) {
    const sel = $('radiusSel');
    sel.innerHTML = '';
    RADII.forEach((r) => {
      const o = document.createElement('option');
      o.value = String(r);
      o.textContent = r === 'All' ? 'Any distance' : `${r} mi`;
      o.selected = r === radius;
      sel.appendChild(o);
    });
  }
  const sort = $('sortBar');
  sort.hidden = false;
  sort.innerHTML = '';
  sort.appendChild(
    chip('\u{1F34B} first', sortMode === 'sours', () => {
      sortMode = 'sours';
      localStorage.setItem(SORT_KEY, sortMode);
      renderList();
    })
  );
  sort.appendChild(
    chip('Nearest', sortMode === 'dist', () => {
      sortMode = 'dist';
      localStorage.setItem(SORT_KEY, sortMode);
      renderList();
    })
  );
  sort.appendChild(
    // breweries where a drinker has manually marked a beer On Tap
    chip('\u{1F44D} on tap', crowdOnly, () => {
      crowdOnly = !crowdOnly;
      localStorage.setItem(ONLY_KEY, crowdOnly ? '1' : '');
      renderList();
    })
  );
}

$('radiusSel').addEventListener('change', () => {
  const v = $('radiusSel').value;
  radius = v === 'All' ? 'All' : Number(v);
  localStorage.setItem(RADIUS_KEY, v === 'All' ? '' : v);
  renderList();
});

let nameFilter = ''; // live text filter on the results page (not persisted)

function visibleBreweries() {
  let list = state.breweries;
  if (nameFilter) {
    const f = nameFilter.toLowerCase();
    list = list.filter((b) => b.name.toLowerCase().includes(f));
  }
  if (radius !== 'All' && state.origin) {
    list = list.filter((b) => b.miles != null && b.miles <= radius);
  }
  // drinker reports count as live sour info, badged 👥 instead of 🍋
  const hasSours = (b) => (tapInfo(b)?.sours.length || 0) + (state.crowdCounts[b.id] || 0);
  if (crowdOnly) {
    // only breweries with a drinker-reported beer currently marked On Tap
    list = list.filter((b) => state.crowdCounts[b.id]);
  }
  if (sortMode === 'sours') {
    // stable sort: sours float to the top, distance order kept within groups
    list = [...list].sort((a, c) => (hasSours(c) ? 1 : 0) - (hasSours(a) ? 1 : 0));
  }
  return list;
}

function renderList(label) {
  if (label !== undefined) {
    state.listLabel = label; // fresh search — start with an unfiltered list
    nameFilter = '';
    $('listFilter').value = '';
  }
  const shown = visibleBreweries();
  $('listTitle').textContent =
    `${state.listLabel} · ${shown.length} ${shown.length === 1 ? 'Result' : 'Results'}`;
  renderControls();
  const ul = $('breweryList');
  ul.innerHTML = '';
  if (!shown.length) {
    ul.innerHTML = state.breweries.length
      ? `<li class="footnote">${
          nameFilter
            ? 'No brewery names match — check the spelling or clear the search.'
            : crowdOnly
              ? 'No drinker-reported taps here yet — turn off \u{1F465} on tap, or be the first to report one.'
              : `Nothing within ${radius} mi — widen the radius.`
        }</li>`
      : '<li class="footnote">No breweries found here. Try a nearby city.</li>';
  }
  shown.forEach((b, i) => {
    const li = document.createElement('li');
    li.className = 'card';
    li.innerHTML = `
      <div class="info">
        <div class="name"></div>
        <div class="sub"><span class="type-badge"></span><span class="loc"></span></div>
      </div>
      <span class="sour-chip" hidden></span>
      <span class="dist"></span>
      <span class="chev">&#x203A;</span>`;
    li.querySelector('.name').textContent = b.name;
    const info = tapInfo(b);
    const crowdN = state.crowdCounts[b.id] || 0;
    if (info?.sours.length) {
      const chip = li.querySelector('.sour-chip');
      chip.hidden = false;
      chip.textContent = `\u{1F34B} ${info.sours.length}`;
    } else if (crowdN) {
      // drinker-reported, not scraped — different icon so staleness
      // expectations stay honest
      const chip = li.querySelector('.sour-chip');
      chip.hidden = false;
      chip.classList.add('crowd-chip');
      chip.textContent = `\u{1F465} ${crowdN}`;
    }
    li.querySelector('.type-badge').textContent = b.brewery_type || 'brewery';
    li.querySelector('.loc').textContent = [b.city, b.state_province].filter(Boolean).join(', ');
    li.querySelector('.dist').textContent = fmtMiles(b.miles);
    li.addEventListener('click', () => openSheet(b));
    ul.appendChild(li);
  });
  show('list');
}

// ---------- landing quick-access split button ----------
function renderCityDrop() {
  const cities = loadSavedCities();
  const home = cities.find((c) => c.home);
  $('btnCityGo').textContent = home
    ? `🏠 ${home.q}`
    : cities.length
      ? 'Your locations ▾'
      : 'Add your locations…';
  $('btnCityDrop').hidden = !cities.length;
  // label makes it obvious this row is your saved list, not a search box
  $('favLocLabel').hidden = !cities.length;
}

function cityGoAction() {
  const cities = loadSavedCities();
  const home = cities.find((c) => c.home);
  if (home) return openCity(home); // the main expectation: tap name, go there
  if (cities.length) return toggleCityDrop();
  return citiesFlow();
}

function toggleCityDrop() {
  const cities = loadSavedCities();
  const list = $('cityDrop');
  if (!list.hidden) {
    list.hidden = true;
    return;
  }
  list.innerHTML = '';
  cities.forEach((c) => {
    const li = document.createElement('li');
    li.textContent = (c.home ? '🏠 ' : '') + c.q;
    onTap(li, () => {
      list.hidden = true;
      openCity(c);
    });
    list.appendChild(li);
  });
  const manage = document.createElement('li');
  manage.className = 'drop-manage';
  manage.textContent = '⚙︎ Manage locations…';
  onTap(manage, () => {
    list.hidden = true;
    citiesFlow();
  });
  list.appendChild(manage);
  list.hidden = false;
}

// ---------- your cities ----------
function renderCities() {
  const cities = loadSavedCities();
  const ul = $('cityList');
  ul.innerHTML = '';
  if (!cities.length) {
    ul.innerHTML = '<li class="explain">No cities yet — add the ones you drink in.</li>';
  }
  cities.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'city-row';
    li.innerHTML = `
      <span class="city-name"></span>
      <span class="city-covered" hidden>&#x1F34B; live data</span>
      <button class="city-home" aria-label="Set as home location">&#x1F3E0;</button>
      <button class="city-remove" aria-label="Remove">&#x2715;</button>`;
    li.querySelector('.city-name').textContent = c.q;
    li.querySelector('.city-covered').hidden = !isCovered(c);
    const star = li.querySelector('.city-home');
    star.classList.toggle('is-home', !!c.home);
    star.title = c.home ? 'Home location' : 'Set as home location';
    li.querySelector('.city-name').addEventListener('click', () => openCity(c));
    star.addEventListener('click', () => {
      cities.forEach((x, j) => (x.home = j === i && !x.home));
      saveSavedCities(cities);
      renderCities();
    });
    li.querySelector('.city-remove').addEventListener('click', () => {
      cities.splice(i, 1);
      saveSavedCities(cities);
      renderCities();
    });
    ul.appendChild(li);
  });
  $('coveredAreas').textContent =
    areaObjects().map((a) => a.label).join(' · ') || 'Loading…';
  renderCityDrop(); // keep the landing dropdown label in sync with edits
}

/* Live pipeline status. Two sources, cross-checked:
   - status.json on the repo's `status` branch, pushed by the workflows
     as they move city to city (raw.githubusercontent.com, CORS-enabled)
   - GitHub's public runs API to confirm something is actually running
     (a crashed job can leave status.json stale)
   The refresh schedule is fixed at :17 past 1,5,9,13,17,21 UTC. */
const STATUS_URL =
  'https://raw.githubusercontent.com/millsi-byte/sour-beer-finder/status/status.json';
const RUNS_URL =
  'https://api.github.com/repos/millsi-byte/sour-beer-finder/actions/runs?status=in_progress&per_page=5';

function nextRefreshText() {
  const HOURS = [1, 5, 9, 13, 17, 21];
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(17, 0, 0);
  let h = HOURS.find(
    (x) => x > now.getUTCHours() || (x === now.getUTCHours() && now.getUTCMinutes() < 17)
  );
  if (h === undefined) {
    next.setUTCDate(next.getUTCDate() + 1);
    h = HOURS[0];
  }
  next.setUTCHours(h);
  return next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function fetchPipelineState() {
  let status = null;
  let running = false;
  try {
    const r = await fetch(STATUS_URL, { cache: 'no-store' });
    if (r.ok) status = await r.json();
  } catch { /* no status yet */ }
  try {
    const r = await fetch(RUNS_URL);
    if (r.ok) {
      running = ((await r.json()).workflow_runs ?? []).some((x) =>
        /refresh|discover/i.test(x.name)
      );
    }
  } catch { /* offline or rate-limited */ }
  const active = running && status && status.phase !== 'idle';
  return { status, active };
}

function liveLine({ status, active }) {
  if (!active) return `All quiet — next refresh starts ≈ ${nextRefreshText()}.`;
  if (status.phase === 'discovery' && status.current) {
    const q = status.queue?.length
      ? ` Up next: ${status.queue.join(', ')}.`
      : '';
    return `🔄 Scanning ${status.current} for new tap-list sources now.${q}`;
  }
  return '🔄 Refreshing menus of known breweries now.';
}

// ---------- data status page ----------
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // rotation uses python weekday, Mon=0

function nextScanNight(areaIndex) {
  const target = areaIndex % 7;
  const todayPy = (new Date().getUTCDay() + 6) % 7;
  return target === todayPy ? 'tonight' : `${DAY_NAMES[target]} night`;
}

async function statusFlow() {
  show('status');
  $('statusLive').textContent = 'Checking…';
  $('areaSchedule').innerHTML = '';
  await tapsReady;
  const state = await fetchPipelineState();
  $('statusLive').textContent = liveLine(state);
  const hist = state.status?.area_history ?? {};
  areaObjects().forEach((a, i) => {
    const li = document.createElement('li');
    li.className = 'city-row';
    li.innerHTML = '<span class="city-name status-area"></span><span class="city-covered status-when"></span>';
    li.querySelector('.city-name').textContent =
      (state.status?.current === a.label ? '🔄 ' : '') + a.label;
    const last = hist[a.label];
    li.querySelector('.city-covered').textContent =
      (last ? `scanned ${fmtAgo(last)} · ` : '') + `next ${nextScanNight(i)}`;
    $('areaSchedule').appendChild(li);
  });
}

async function citiesFlow() {
  await tapsReady;
  renderCities();
  show('cities');
}

// ---------- detail sheet ----------
function openSheet(b) {
  $('sheetName').textContent = b.name;
  const addr = [b.address_1, b.city, b.state_province].filter(Boolean).join(' · ');
  $('sheetSub').textContent = [addr, fmtMiles(b.miles)].filter(Boolean).join(' — ');

  $('actUntappd').href =
    `https://untappd.com/search?q=${encodeURIComponent(b.name)}&type=venues`;

  const override = state.taps?.brewery_overrides?.[b.id];
  const site = override !== undefined ? override.website_url : b.website_url;
  $('actWebsite').hidden = !site;
  if (site) $('actWebsite').href = site;

  $('actMaps').href = directionsUrl(b);

  // Tap List starts expanded on every open
  setTapListOpen(true);
  renderSheetPills(b);
  renderTapList(b);
  $('editSiteForm').hidden = true;
  $('editSiteForm').reset();

  $('addBrewerySheet').hidden = true;
  $('addBeerSheet').hidden = true;
  $('sheet').hidden = false;
  $('sheetBackdrop').hidden = false;
}

// ---------- sheet: Favorite + Check In pills, collapsible Tap List ----------
function setTapListOpen(open) {
  $('tapListBody').hidden = !open;
  $('tapListToggle').setAttribute('aria-expanded', String(open));
  $('tapListToggle').classList.toggle('collapsed', !open);
}

$('tapListToggle').addEventListener('click', () =>
  setTapListOpen($('tapListBody').hidden)
);

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function renderSheetPills(b) {
  const fav = $('btnFavBrewery');
  const chk = $('btnCheckIn');
  const enabled = await crowd.crowdEnabled();
  fav.hidden = chk.hidden = !enabled;
  if (!enabled || sheetBrewery !== b) return;
  fav.textContent = '⭐ Favorite';
  if (crowd.authState()) {
    const { favs } = await crowd.myMarks();
    if (sheetBrewery !== b) return;
    if (favs.has(`brewery|${b.id}`)) fav.textContent = '★ Favorited';
  }
}

/* A sheet can be opened on top of the Breweries/Beers tab without
   navigating away from it — so a favorite/had-it/check-in toggle must
   refresh that tab's own lists too, not just the sheet's pill, or the
   change only shows up after leaving and re-entering the tab. */
function refreshCurrentTabMarks() {
  if (state.view === 'breweries') breweriesFlow();
  else if (state.view === 'beers') beersFlow();
}

$('btnFavBrewery').addEventListener('click', async () => {
  const b = sheetBrewery;
  if (!b) return;
  if (!crowd.authState()) {
    showToast('Sign in (Settings → Profile) to save favorites.');
    return;
  }
  $('btnFavBrewery').disabled = true;
  try {
    const on = await crowd.toggleFav('brewery', b.id, {
      brewery_id: b.id,
      brewery_name: b.name,
      city: b.city,
      state: b.state_province,
    });
    showToast(on ? `⭐ ${b.name} favorited` : `Removed ${b.name} from favorites`);
    renderSheetPills(b);
    refreshCurrentTabMarks();
  } catch (e) {
    showToast(e.message);
  } finally {
    $('btnFavBrewery').disabled = false;
  }
});

$('btnCheckIn').addEventListener('click', async () => {
  const b = sheetBrewery;
  if (!b) return;
  if (!crowd.authState()) {
    showToast('Sign in (Settings → Profile) to check in.');
    return;
  }
  $('btnCheckIn').disabled = true;
  try {
    await crowd.checkIn(b);
    showToast(`🍻 Checked in at ${b.name}`);
    refreshCurrentTabMarks();
  } catch (e) {
    showToast(e.message);
  } finally {
    $('btnCheckIn').disabled = false;
  }
});

// ---------- crowd layer: drinker reports (see crowd.js) ----------
let sheetBrewery = null;
let crStars = 0;

function starRow(n) {
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
}

/* One tap list: scanned beers and drinker-reported beers are the same
   kind of thing, merged by beer_key — where a beer came from is a badge
   on its row, not a section boundary. Everything conversational (reviews,
   marking on tap/gone) lives on the beer's own sheet, one tap away. */
async function renderTapList(b) {
  sheetBrewery = b;
  $('crowdForm').hidden = true;
  $('crNote').hidden = true;
  $('tlEmpty').hidden = true;
  const ul = $('crowdList');
  ul.innerHTML = '';
  const enabled = await crowd.crowdEnabled();
  if (sheetBrewery !== b) return;
  $('btnCrowdReport').hidden = !enabled;
  const drinkers = enabled ? await crowd.crowdBeersFor(b.id) : [];
  if (sheetBrewery !== b) return;

  const byKey = new Map();
  for (const s of scannedBeersFor(b.id)) byKey.set(s.beer_key, s);
  for (const d of drinkers) {
    const s = byKey.get(d.beer_key);
    byKey.set(d.beer_key, s ? { ...d, scanned: true, scanned_at: s.scanned_at } : d);
  }
  // gone beers sink to the bottom; menu order / report order kept otherwise
  const beers = [...byKey.values()].sort(
    (x, y) => (x.currentlyGone ? 1 : 0) - (y.currentlyGone ? 1 : 0)
  );

  $('tlTitle').textContent = beers.length ? `Tap List · ${beers.length}` : 'Tap List';
  const info = tapInfo(b);
  const bits = [];
  if (info) {
    bits.push(info.sours.length
      ? `🍋 Menu scanned ${fmtAgo(info.fetched_at)} · ${SOURCE_LABELS[info.source] ?? `via ${info.source}`}`
      : `🍋 Nothing sour among ${info.beer_count} beers on the menu · scanned ${fmtAgo(info.fetched_at)}`);
  } else {
    bits.push('No auto-scanned menu for this brewery');
  }
  if (beers.some((x) => x.trail?.length || x.reports?.length)) bits.push('👤 = reported');
  $('tlNote').textContent = bits.join(' · ');
  $('tlEmpty').hidden = !!beers.length;
  beers.forEach((beer) => ul.appendChild(tapListRow(beer)));
}

/* who/when line for the beer sheet's status card */
function lastStatusText(beer) {
  const last = beer.trail.at(-1);
  if (last) return `${last.author || 'a drinker'} · ${fmtWhen(last.created_at)}`;
  const src = beer.reports.at(-1); // oldest report = first record
  if (src?.kind === 'beer') return `added by ${src.author || 'a drinker'} · ${fmtWhen(src.created_at)}`;
  return `${src?.author || 'a drinker'} · ${fmtWhen(src?.created_at)}`;
}

/* NEW = user-added to the catalog, no on-tap claim yet */
function beerStatusKind(beer) {
  if (beer.currentlyGone) return 'gone';
  if (beer.trail?.length) return 'on';
  const newest = beer.reports?.[0]; // reports are sorted newest-first
  if (newest?.kind === 'beer') return 'new';
  return 'on'; // scanned, or a drinker report (an on-tap claim)
}

function tapListRow(beer) {
  const li = document.createElement('li');
  const kind = beerStatusKind(beer);
  li.className = 'tl-row' + (kind === 'gone' ? ' tl-gone' : '');

  const who = document.createElement('div');
  who.className = 'tl-who';
  const name = document.createElement('div');
  name.className = 'tl-beer';
  name.textContent = beer.beer_name;
  const meta = document.createElement('div');
  meta.className = 'tl-meta';
  const bits = [];
  if (beer.style && beer.style !== beer.beer_name) bits.push(beer.style);
  if (beer.avgRating) bits.push(`★ ${beer.avgRating}`);
  const nNotes = (beer.reports?.filter((r) => r.review).length || 0) + (beer.comments?.length || 0);
  if (nNotes) bits.push(`💬 ${nNotes}`);
  meta.textContent = bits.join(' · ');
  who.append(name, meta);
  li.appendChild(who);

  const lastSig = beer.trail?.at(-1) ?? beer.reports?.[0];
  const src = document.createElement('span');
  src.className = 'chip chip-src';
  src.textContent = lastSig ? `👤 ${lastSig.author || 'drinker'}` : '🍋 menu';
  src.title = lastSig ? `Reported ${fmtWhen(lastSig.created_at)}` : 'On the scanned menu';
  li.appendChild(src);

  const status = document.createElement('span');
  status.className = 'chip ' + (kind === 'gone' ? 'chip-gone' : kind === 'new' ? 'chip-new' : 'chip-on');
  status.textContent = kind === 'gone' ? 'GONE' : kind === 'new' ? 'NEW' : 'ON TAP';
  li.appendChild(status);

  li.addEventListener('click', () => openBeerSheet(beer, { fromBrewery: true }));
  return li;
}

/* Shared mark handler: signed-in = one tap; anonymous = inline name form.
   Brewery-sheet rows rebuild their buttons on every render, so a stuck
   `disabled` flag never shows there — but the beer sheet's Mark buttons
   are static elements that persist across renders, so this must always
   re-enable on success too, not just on error, or the button (and every
   beer sheet opened after it) is stuck unclickable for the rest of the
   session. */
function markBeer(target, vote, btn, host, onDone) {
  if (crowd.authState()) {
    btn.disabled = true;
    crowd
      .submitVote(target, vote)
      .then((r) => {
        btn.disabled = false;
        refreshCrowdCounts();
        return onDone(r);
      })
      .catch((e) => {
        showToast(e.message);
        btn.disabled = false;
      });
    return;
  }
  if (host.querySelector('.crowd-vform')) return;
  host.appendChild(crowdStatusForm(target, vote, onDone));
}

function crowdStatusForm(rep, vote, onDone) {
  const form = document.createElement('form');
  form.className = 'missingform crowd-vform';
  form.innerHTML = `
    <input type="text" class="cv-author" placeholder="Your name (optional)" maxlength="40">
    <button type="submit" class="secondary block">${
      vote === 'gone' ? 'Confirm: it’s gone' : 'Confirm: it’s on tap'
    }</button>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelector('button').disabled = true;
    try {
      await crowd.submitVote(rep, vote, form.querySelector('.cv-author').value.trim());
      refreshCrowdCounts();
      (onDone ?? (() => renderTapList(sheetBrewery)))();
    } catch {
      form.querySelector('button').disabled = false;
    }
  });
  return form;
}

function renderStarsInput() {
  const bar = $('crStars');
  bar.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'star-btn';
    s.textContent = i <= crStars ? '★' : '☆';
    s.setAttribute('aria-label', `${i} star${i > 1 ? 's' : ''}`);
    s.addEventListener('click', () => {
      crStars = crStars === i ? 0 : i; // tap the same star again to clear
      renderStarsInput();
    });
    bar.appendChild(s);
  }
}

$('btnCrowdReport').addEventListener('click', () => {
  const f = $('crowdForm');
  f.hidden = !f.hidden;
  if (!f.hidden) {
    crStars = 0;
    renderStarsInput();
    $('crBeer').focus();
  }
});

$('crowdFormCancel').addEventListener('click', () => {
  $('crowdForm').hidden = true;
  $('crowdForm').reset();
});

$('crowdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const beer = $('crBeer').value.trim();
  if (!beer || !sheetBrewery) return;
  const btn = $('crowdForm').querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await crowd.submitReport({
      brewery: sheetBrewery,
      beer_name: beer,
      rating: crStars || undefined,
      author: $('crAuthor').value.trim(),
      review: $('crReview').value.trim(),
    });
    $('crowdForm').reset();
    $('crowdForm').hidden = true;
    refreshCrowdCounts();
    renderTapList(sheetBrewery);
  } catch {
    const note = $('crNote');
    note.hidden = false;
    note.textContent = "Couldn't post right now — try again in a minute.";
  } finally {
    btn.disabled = false;
  }
});

function closeSheet() {
  $('sheet').hidden = true;
  $('beerSheet').hidden = true;
  $('addBrewerySheet').hidden = true;
  $('addBeerSheet').hidden = true;
  $('sheetBackdrop').hidden = true;
}

// ---------- beer sheet ----------
let sheetBeer = null; // assembled beer (crowd.js shape) currently shown
let bsStars = 0;
let bsCameFromBrewery = false;

/* Scanned beers for one brewery, as beer-shaped seeds. */
function scannedBeersFor(breweryId) {
  const info = state.taps?.breweries?.[breweryId];
  if (!info) return [];
  return info.sours.map((s) => ({
    beer_key: crowd.beerKey(breweryId, s.name),
    beer_name: s.name,
    style: s.style,
    brewery_id: breweryId,
    brewery_name: info.name,
    scanned: true,
    scanned_at: info.fetched_at,
  }));
}

/* Every beer S4S knows: scanned sours (all breweries in taps.json) +
   drinker-reported + user-added, merged by beer_key. */
async function beerCatalog() {
  const byKey = new Map();
  for (const bid of Object.keys(state.taps?.breweries ?? {})) {
    for (const b of scannedBeersFor(bid)) byKey.set(b.beer_key, b);
  }
  for (const b of await crowd.crowdBeerCatalog()) {
    const scanned = byKey.get(b.beer_key);
    byKey.set(b.beer_key, scanned ? { ...scanned, ...b, scanned: true } : b);
  }
  return [...byKey.values()];
}

async function openBeerSheet(seed, { fromBrewery = false } = {}) {
  // sticky across re-renders: a mark/review refresh happens while the
  // brewery sheet is hidden, but the way back to it still exists
  bsCameFromBrewery = fromBrewery && (!$('sheet').hidden || bsCameFromBrewery);
  $('sheet').hidden = true;
  $('addBrewerySheet').hidden = true;
  $('addBeerSheet').hidden = true; // a just-added beer opens on top of the add sheet
  $('sheetBackdrop').hidden = false;
  $('beerSheet').hidden = false;
  $('beerBack').hidden = !bsCameFromBrewery;
  $('bsReviewForm').hidden = true;
  $('bsError').hidden = true;
  $('bsVForm').innerHTML = '';

  // merge live crowd data over the seed (seed may be scanned-only)
  const live = (await crowd.crowdBeer(seed.beer_key)) ?? {};
  const beer = {
    ...seed,
    ...Object.fromEntries(Object.entries(live).filter(([, v]) => v != null)),
    beer_name: live.beer_name || seed.beer_name,
    style: live.style || seed.style,
    brewery_name: live.brewery_name || seed.brewery_name,
    brewery_id: live.brewery_id || seed.brewery_id,
    reports: live.reports ?? [],
    comments: live.comments ?? [],
    trail: live.trail ?? [],
  };
  sheetBeer = beer;

  $('bsName').textContent = beer.beer_name || '(unnamed beer)';
  $('bsSub').textContent = [beer.style, beer.brewery_name].filter(Boolean).join(' · ');

  // status card: chip carries the state, the line under it says who/when
  const chip = $('bsChip');
  const card = $('bsStatusCard');
  chip.hidden = false;
  card.classList.remove('on');
  if (beer.reports.length || beer.trail.length) {
    const kind = beerStatusKind(beer);
    chip.className = 'chip ' + (kind === 'gone' ? 'chip-gone' : kind === 'new' ? 'chip-new' : 'chip-on');
    chip.textContent = kind === 'gone' ? 'GONE' : kind === 'new' ? 'NEW' : '● ON TAP';
    if (kind === 'on') card.classList.add('on');
    $('bsStatus').textContent = lastStatusText(beer);
    $('bsStatusNote').textContent = '';
  } else if (beer.scanned) {
    chip.className = 'chip chip-on';
    chip.textContent = '● ON TAP';
    card.classList.add('on');
    $('bsStatus').textContent = '🍋 On the scanned tap list';
    $('bsStatusNote').textContent = `from the brewery's own menu · updated ${fmtAgo(beer.scanned_at)}`;
  } else {
    chip.hidden = true;
    $('bsStatus').textContent = 'No tap status yet';
    $('bsStatusNote').textContent = 'Be the first to mark it On Tap.';
  }

  renderBeerPills(beer);
  renderBeerReviews(beer);
}

/* Inline edit form for one of your own reviews/comments — name and
   text/rating only (rules block anything else). Swaps in place of the
   <li>; Cancel or a successful save both fall back to a full re-render. */
function editNoteRow(n, beer) {
  const li = document.createElement('li');
  li.className = 'crowd-item';
  const form = document.createElement('form');
  form.className = 'missingform crowd-form';
  const stars = document.createElement('div');
  stars.className = 'stars';
  let editStars = n.rating || 0;
  const renderEditStars = () => {
    stars.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'star-btn';
      b.textContent = i <= editStars ? '★' : '☆';
      b.addEventListener('click', () => {
        editStars = editStars === i ? 0 : i;
        renderEditStars();
      });
      stars.appendChild(b);
    }
  };
  renderEditStars();
  const text = document.createElement('textarea');
  text.rows = 2;
  text.maxLength = 400;
  text.required = true;
  text.value = n.review || n.text || '';
  const author = document.createElement('input');
  author.type = 'text';
  author.maxLength = 40;
  author.placeholder = 'Your name (optional)';
  author.value = n.author || '';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'secondary block';
  save.textContent = 'Save changes';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'linkbtn mb-alt';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => renderBeerReviews(beer));
  form.append(stars, text, author, save, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const patch = { author: author.value.trim(), rating: editStars || undefined };
    patch[n.kind === 'comment' ? 'text' : 'review'] = text.value.trim();
    try {
      await crowd.updateDoc('reports', n._id, patch);
      openBeerSheet(beer, { fromBrewery: bsCameFromBrewery });
    } catch (err) {
      showToast(err.message);
      save.disabled = false;
    }
  });
  li.appendChild(form);
  return li;
}

function renderBeerReviews(beer) {
  const ul = $('bsReviews');
  ul.innerHTML = '';
  $('bsRating').textContent = beer.avgRating
    ? `${starRow(Math.round(beer.avgRating))} ${beer.avgRating} from ${beer.ratingCount} rating${beer.ratingCount > 1 ? 's' : ''}`
    : 'No ratings yet.';
  const notes = [
    ...beer.reports.filter((r) => r.review || r.rating),
    ...beer.comments,
  ].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  $('bsRevHead').textContent = notes.length ? `Reviews · ${notes.length}` : 'Reviews';
  for (const n of notes) {
    const li = document.createElement('li');
    li.className = 'review-row';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (n.author || '?').trim().charAt(0).toUpperCase() || '?';
    li.appendChild(av);
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'review-body';
    li.appendChild(bodyWrap);
    const head = document.createElement('div');
    head.className = 'crowd-meta';
    head.textContent = `${n.author || 'a drinker'} · ${fmtAgo(n.created_at)}${n.rating ? ' · ' + starRow(n.rating) : ''}`;
    bodyWrap.appendChild(head);
    const body = document.createElement('div');
    body.className = 'crowd-review';
    body.textContent = n.review || n.text || '';
    if (body.textContent) bodyWrap.appendChild(body);
    // self-serve edit/delete on your own review/comment (uid-stamped only
    // — anonymous notes have nothing to check identity against)
    const li0 = li; // the row being replaced on edit
    if (n.uid && crowd.authState()?.uid === n.uid) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'linkbtn mark-del-inline';
      edit.textContent = '✎ Edit';
      edit.addEventListener('click', () => li0.replaceWith(editNoteRow(n, beer)));
      bodyWrap.appendChild(edit);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkbtn mark-del-inline';
      del.textContent = '✕ Remove';
      del.addEventListener('click', async () => {
        if (!confirm('Remove this review/comment?')) return;
        try {
          await crowd.deleteDoc('reports', n._id);
          openBeerSheet(beer, { fromBrewery: bsCameFromBrewery });
        } catch (err) {
          showToast(err.message);
        }
      });
      bodyWrap.appendChild(del);
    } else if (!n.uid && n.author && crowd.authState()?.display_name === n.author) {
      // likely their own note, posted before they had a profile — nothing
      // to check identity against, so editing/deleting it isn't possible
      const note = document.createElement('div');
      note.className = 'crowd-meta';
      note.textContent = "Posted before you had a profile — can't be edited or removed.";
      bodyWrap.appendChild(note);
    }
    ul.appendChild(li);
  }
}

async function renderBeerPills(beer) {
  const fav = $('btnFavBeer');
  const had = $('btnHadBeer');
  fav.textContent = '⭐ Favorite';
  had.textContent = '✔ I’ve had this';
  if (crowd.authState()) {
    const { favs, had: hadMap } = await crowd.myMarks();
    if (sheetBeer?.beer_key !== beer.beer_key) return;
    if (favs.has(`beer|${beer.beer_key}`)) fav.textContent = '★ Favorited';
    if (hadMap.has(`beer|${beer.beer_key}`)) had.textContent = '✅ Had it!';
  }
}

function beerDenorm(beer) {
  return {
    beer_key: beer.beer_key,
    beer_name: beer.beer_name,
    brewery_id: beer.brewery_id,
    brewery_name: beer.brewery_name,
    style: beer.style,
  };
}

$('btnFavBeer').addEventListener('click', async () => {
  const beer = sheetBeer;
  if (!beer) return;
  if (!crowd.authState()) return showToast('Sign in (Settings → Profile) to save favorites.');
  try {
    const on = await crowd.toggleFav('beer', beer.beer_key, beerDenorm(beer));
    showToast(on ? `⭐ ${beer.beer_name} favorited` : 'Removed from favorites');
    renderBeerPills(beer);
    refreshCurrentTabMarks();
  } catch (e) {
    showToast(e.message);
  }
});

$('btnHadBeer').addEventListener('click', async () => {
  const beer = sheetBeer;
  if (!beer) return;
  if (!crowd.authState()) return showToast('Sign in (Settings → Profile) to track beers you’ve had.');
  try {
    const on = await crowd.toggleHad(beer.beer_key, beerDenorm(beer));
    showToast(on ? `✅ Marked as had — cheers!` : 'Unmarked.');
    renderBeerPills(beer);
    refreshCurrentTabMarks();
  } catch (e) {
    showToast(e.message);
  }
});

for (const [id, vote] of [['bsMarkOn', 'still'], ['bsMarkGone', 'gone']]) {
  $(id).addEventListener('click', () => {
    const beer = sheetBeer;
    if (!beer) return;
    markBeer(beer, vote, $(id), $('bsVForm'), () => openBeerSheet(beer, { fromBrewery: bsCameFromBrewery }));
  });
}

$('bsAddReview').addEventListener('click', () => {
  const f = $('bsReviewForm');
  f.hidden = !f.hidden;
  if (!f.hidden) {
    bsStars = 0;
    renderBsStars();
    $('bsAuthor').hidden = !!crowd.authState();
    $('bsText').focus();
  }
});

$('bsReviewCancel').addEventListener('click', () => {
  $('bsReviewForm').hidden = true;
  $('bsReviewForm').reset();
});

function renderBsStars() {
  const bar = $('bsStars');
  bar.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'star-btn';
    b.textContent = i <= bsStars ? '★' : '☆';
    b.addEventListener('click', () => {
      bsStars = bsStars === i ? 0 : i;
      renderBsStars();
    });
    bar.appendChild(b);
  }
}

$('bsReviewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const beer = sheetBeer;
  const text = $('bsText').value.trim();
  if (!beer || !text) return;
  const btn = $('bsReviewForm').querySelector('button[type=submit]');
  btn.disabled = true;
  $('bsError').hidden = true;
  try {
    await crowd.submitComment(beer, {
      text,
      rating: bsStars || undefined,
      author: $('bsAuthor').value.trim(),
    });
    $('bsReviewForm').reset();
    $('bsReviewForm').hidden = true;
    openBeerSheet(beer, { fromBrewery: bsCameFromBrewery });
  } catch (err) {
    $('bsError').hidden = false;
    $('bsError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('beerBack').addEventListener('click', () => {
  $('beerSheet').hidden = true;
  if (bsCameFromBrewery && sheetBrewery) {
    $('sheet').hidden = false;
    renderTapList(sheetBrewery); // fresh marks/status after edits
  } else {
    $('sheetBackdrop').hidden = true;
  }
});

// ---------- flows ----------
function fail(msg) {
  show('locate');
  const el = $('locateError');
  el.textContent = msg;
  el.hidden = false;
}

async function locateFlow() {
  $('locateError').hidden = true;
  show('loading');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.lastSearch = null;
        const raw = await fetchByDist(state.origin.lat, state.origin.lng);
        await tapsReady;
        state.breweries = prepare(raw, state.origin);
        renderList('Near you');
      } catch (e) {
        fail(`Couldn't load breweries: ${e.message}`);
      }
    },
    (err) => {
      fail(
        err.code === err.PERMISSION_DENIED
          ? 'Location access denied — search by city instead.'
          : 'Couldn’t get your location — search by city instead.'
      );
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
  );
}

/* Coordinate search: includes suburbs and shows real distances. */
async function coordsFlow(label, lat, lng) {
  $('locateError').hidden = true;
  show('loading');
  try {
    state.origin = { lat, lng };
    state.lastSearch = { label, lat, lng };
    const raw = await fetchByDist(lat, lng);
    await tapsReady;
    state.breweries = prepare(raw, state.origin);
    renderList(label);
  } catch (e) {
    fail(`Couldn't load breweries: ${e.message}`);
  }
}

/* Saved-city entry: coords when added via autocomplete, name otherwise. */
function openCity(c) {
  if (c.lat != null) coordsFlow(c.q, c.lat, c.lng);
  else cityFlow(c.q);
}

async function cityFlow(q) {
  $('locateError').hidden = true;
  show('loading');
  try {
    const [city, st] = q.split(',').map((s) => s.trim()).filter(Boolean);
    if (!city) return fail('Enter a city name.');
    state.origin = null;
    state.lastSearch = null;
    state.lastCity = q;
    const raw = await fetchByCity(city, st);
    await tapsReady;
    state.breweries = prepare(raw, null, city);
    renderList(q);
  } catch (e) {
    fail(`Couldn't load breweries: ${e.message}`);
  }
}

// ---------- wire up ----------
$('btnLocate').addEventListener('click', locateFlow);

const searchAC = attachCityAutocomplete($('cityInput'), (c) =>
  coordsFlow(c.label, c.lat, c.lng)
);
$('cityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const typed = $('cityInput').value.trim();
  const pick = searchAC.first() ?? (await geocodeCities(typed))[0];
  searchAC.close();
  if (pick) coordsFlow(pick.label, pick.lat, pick.lng);
  else cityFlow(typed); // geocoder found nothing — try the name as-is
});

$('listFilter').addEventListener('input', () => {
  nameFilter = $('listFilter').value.trim();
  renderList();
});

$('btnListHome').addEventListener('click', () => show('locate'));
// visible only on the Data Status page — re-fetches the live statuses
$('btnRefresh').addEventListener('click', statusFlow);
$('btnRefresh').hidden = true;
$('brandHome').addEventListener('click', () => show('locate'));
$('btnDataStatus').addEventListener('click', statusFlow);
$('btnStatusBack').addEventListener('click', () => { renderSettingsPage(); show('settings'); });
$('btnProfilePage').addEventListener('click', () => {
  renderProfilePage();
  show('profile');
});
$('btnProfileBack').addEventListener('click', () => { renderSettingsPage(); show('settings'); });

// bottom navigation — each tab runs its view's setup flow
$('navSearch').addEventListener('click', () => show('locate'));
$('navLocations').addEventListener('click', citiesFlow);
$('navBreweries').addEventListener('click', breweriesFlow);
$('navBeers').addEventListener('click', beersFlow);
$('navSettings').addEventListener('click', () => { renderSettingsPage(); show('settings'); });

// ---------- Breweries tab ----------
/* Favorites rows use the same icon+X style as the Locations list —
   tap the name to open, tap X to remove right from the list. */
function breweryRowCard(b, subText, onRemove, removeTitle) {
  const li = document.createElement('li');
  li.className = 'city-row';
  li.innerHTML = `
    <span class="city-name"></span>
    <span class="city-covered" hidden></span>
    <button type="button" class="linkbtn mark-del" title="${removeTitle || 'Remove from favorites'}">&#x2715;</button>`;
  const sub = subText ?? [b.city, b.state_province].filter(Boolean).join(', ');
  li.querySelector('.city-name').textContent = [b.name, sub].filter(Boolean).join(' — ');
  const info = state.taps?.breweries?.[b.id];
  const crowdN = state.crowdCounts[b.id] || 0;
  const badge = li.querySelector('.city-covered');
  if (info?.sours.length) {
    badge.hidden = false;
    badge.textContent = `\u{1F34B} ${info.sours.length}`;
  } else if (crowdN) {
    badge.hidden = false;
    badge.textContent = `\u{1F465} ${crowdN}`;
  }
  li.querySelector('.city-name').addEventListener('click', () => openBreweryById(b.id, b));
  li.querySelector('.mark-del').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (onRemove) await onRemove();
  });
  return li;
}

/* Open the brewery sheet from anywhere (favorites, check-ins, search):
   full OBDB record when fetchable, extras/partial data otherwise. */
async function openBreweryById(id, fallback) {
  let b = null;
  if (id.startsWith('x-')) {
    const e = (state.taps?.extra_breweries ?? []).find((x) => x.id === id);
    if (e) {
      b = {
        id: e.id, name: e.name, brewery_type: 'micro', city: e.city,
        state_province: e.state, latitude: String(e.lat), longitude: String(e.lng),
        website_url: e.website_url || null,
      };
    }
  } else {
    try {
      const res = await fetch(`${API}/${id}`);
      if (res.ok) b = await res.json();
    } catch {
      /* offline — fall back to what we know */
    }
  }
  b = b ?? fallback;
  if (!b) return showToast("Couldn't load that brewery right now.");
  const lat = parseFloat(b.latitude);
  const lng = parseFloat(b.longitude);
  openSheet({
    ...b,
    lat,
    lng,
    hasCoords: Number.isFinite(lat) && Number.isFinite(lng),
    miles: state.origin && Number.isFinite(lat)
      ? haversineMiles(state.origin, { lat, lng })
      : null,
  });
}

/* Brewery search: OBDB by-name + hand-added extras, debounced. */
async function searchBreweries(q) {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  let hits = [];
  try {
    const res = await fetch(`${API}?by_name=${encodeURIComponent(needle)}&per_page=8`);
    if (res.ok) hits = (await res.json()).filter((b) => !HIDDEN_TYPES.has(b.brewery_type));
  } catch {
    /* offline — extras still searchable below */
  }
  const extras = (state.taps?.extra_breweries ?? [])
    .filter((e) => e.name.toLowerCase().includes(needle))
    .map((e) => ({
      id: e.id, name: e.name, brewery_type: 'micro', city: e.city,
      state_province: e.state, latitude: String(e.lat), longitude: String(e.lng),
      website_url: e.website_url || null,
    }));
  const seen = new Set();
  return [...extras, ...hits].filter((b) => !seen.has(b.id) && seen.add(b.id)).slice(0, 10);
}

function attachSuggest(inputId, listId, searchFn, renderLabel, onPick) {
  const input = $(inputId);
  const list = $(listId);
  let timer = 0;
  const close = () => {
    list.hidden = true;
    list.innerHTML = '';
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const hits = await searchFn(q);
      if (document.activeElement !== input) return close();
      list.innerHTML = '';
      hits.forEach((h) => {
        const li = document.createElement('li');
        li.textContent = renderLabel(h);
        onTap(li, () => {
          close();
          onPick(h, input);
        });
        list.appendChild(li);
      });
      list.hidden = !hits.length;
    }, 300);
  });
  input.addEventListener('blur', () => setTimeout(close, 200));
}

async function breweriesFlow() {
  await tapsReady;
  show('breweries');
  // favorites + check-ins (signed-in only)
  const favUl = $('brewFavs');
  const chkUl = $('brewCheckins');
  favUl.innerHTML = '';
  chkUl.innerHTML = '';
  if (!crowd.authState()) {
    $('brewFavsNote').textContent = 'Sign in (Settings → Profile) to keep favorites.';
    $('brewCheckinsNote').textContent = 'Sign in to start a check-in history.';
    return;
  }
  const { favs, checkins } = await crowd.myMarks();
  const brewFavs = [...favs.values()].filter((e) => e.target_type === 'brewery');
  $('brewFavsNote').textContent = brewFavs.length
    ? ''
    : 'No favorites yet — tap ⭐ Favorite on any brewery.';
  brewFavs.forEach((e) =>
    favUl.appendChild(
      breweryRowCard(
        { id: e.target_key, name: e.brewery_name || '(brewery)', city: e.city, state_province: e.state },
        undefined,
        async () => {
          try {
            await crowd.toggleFav('brewery', e.target_key, {
              brewery_id: e.target_key, brewery_name: e.brewery_name, city: e.city, state: e.state,
            });
            showToast(`Removed ${e.brewery_name || 'brewery'} from favorites`);
            breweriesFlow();
          } catch (err) {
            showToast(err.message);
          }
        }
      )
    )
  );
  $('brewCheckinsNote').textContent = checkins.length
    ? ''
    : 'No check-ins yet — tap ✅ Check In on a brewery when you’re there.';
  checkins.slice(0, 25).forEach((e) => {
    const li = document.createElement('li');
    li.className = 'city-row';
    li.innerHTML = '<span class="city-name"></span><span class="city-covered"></span><button type="button" class="linkbtn mark-del" title="Remove this check-in">&#x2715;</button>';
    li.querySelector('.city-name').textContent = e.brewery_name || '(brewery)';
    li.querySelector('.city-covered').textContent = fmtWhen(e.created_at);
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => openBreweryById(e.brewery_id, null));
    li.querySelector('.mark-del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Remove your check-in at ${e.brewery_name || 'this brewery'}?`)) return;
      try {
        await crowd.deleteDoc('user_marks', e._id);
        breweriesFlow();
      } catch (err) {
        showToast(err.message);
      }
    });
    chkUl.appendChild(li);
  });
}

attachSuggest(
  'brewSearch',
  'brewSuggest',
  searchBreweries,
  (b) => `${b.name} — ${[b.city, b.state_province].filter(Boolean).join(', ')}`,
  (b, input) => {
    input.value = '';
    openBreweryById(b.id, b);
  }
);

// ---------- Beers tab ----------
async function searchBeersLocal(q) {
  const needle = q.trim().toLowerCase();
  const all = await beerCatalog();
  return all
    .filter(
      (b) =>
        (b.beer_name ?? '').toLowerCase().includes(needle) ||
        (b.brewery_name ?? '').toLowerCase().includes(needle) ||
        (b.style ?? '').toLowerCase().includes(needle)
    )
    .slice(0, 12);
}

function beerRowCard(seed, onRemove, removeTitle) {
  const li = document.createElement('li');
  li.className = 'city-row';
  li.innerHTML = `
    <span class="city-name"></span>
    <span class="city-covered" hidden></span>
    <button type="button" class="linkbtn mark-del" title="${removeTitle || 'Remove'}">&#x2715;</button>`;
  const sub = [seed.style, seed.brewery_name].filter(Boolean).join(' · ');
  li.querySelector('.city-name').textContent = [seed.beer_name || '(beer)', sub].filter(Boolean).join(' — ');
  li.querySelector('.city-name').addEventListener('click', () => openBeerSheet(seed));
  li.querySelector('.mark-del').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (onRemove) await onRemove();
  });
  return li;
}

async function beersFlow() {
  await tapsReady;
  show('beers');
  const signedIn = !!crowd.authState();
  const favUl = $('beerFavs');
  const hadUl = $('beerHad');
  favUl.innerHTML = '';
  hadUl.innerHTML = '';
  if (!signedIn) {
    $('beerFavsNote').textContent = 'Sign in (Settings → Profile) to keep favorites.';
    $('beerHadNote').textContent = 'Sign in to track beers you’ve had.';
    return;
  }
  const { favs, had } = await crowd.myMarks();
  const beerFavs = [...favs.values()].filter((e) => e.target_type === 'beer');
  const hadBeers = [...had.values()];
  $('beerFavsNote').textContent = beerFavs.length ? '' : 'No favorites yet — tap ⭐ on any beer.';
  $('beerHadNote').textContent = hadBeers.length
    ? ''
    : 'Nothing yet — tap ✔ I’ve had this on a beer you’ve tried.';
  beerFavs.forEach((e) => {
    const seed = {
      beer_key: e.target_key, beer_name: e.beer_name, style: e.style,
      brewery_id: e.brewery_id, brewery_name: e.brewery_name,
    };
    favUl.appendChild(beerRowCard(seed, async () => {
      try {
        await crowd.toggleFav('beer', e.target_key, beerDenorm(seed));
        showToast('Removed from favorites');
        beersFlow();
      } catch (err) {
        showToast(err.message);
      }
    }, 'Remove from favorites'));
  });
  hadBeers.forEach((e) => {
    const seed = {
      beer_key: e.target_key, beer_name: e.beer_name, style: e.style,
      brewery_id: e.brewery_id, brewery_name: e.brewery_name,
    };
    hadUl.appendChild(beerRowCard(seed, async () => {
      try {
        await crowd.toggleHad(e.target_key, beerDenorm(seed));
        showToast('Unmarked.');
        beersFlow();
      } catch (err) {
        showToast(err.message);
      }
    }, "Remove from I’ve had these"));
  });
}

attachSuggest(
  'beerSearch',
  'beerSuggest',
  searchBeersLocal,
  (b) => `${b.beer_name} — ${[b.style, b.brewery_name].filter(Boolean).join(' · ')}`,
  (b, input) => {
    input.value = '';
    openBeerSheet(b);
  }
);

/* Add-a-beer bottom sheet, opened from the Beers tab header. */
async function openAddBeerSheet() {
  const enabled = await crowd.crowdEnabled();
  const signedIn = !!crowd.authState();
  $('beerAddForm').hidden = !enabled || !signedIn;
  $('beerAddGate').hidden = enabled && signedIn;
  $('beerAddGate').textContent = !enabled
    ? 'Beer submissions aren’t turned on yet.'
    : 'Sign in (Settings → Profile) to add a beer.';
  $('baError').hidden = true;
  $('beerAddForm').reset();
  baPickedBrewery = null;
  $('sheet').hidden = true;
  $('beerSheet').hidden = true;
  $('addBrewerySheet').hidden = true;
  $('addBeerSheet').hidden = false;
  $('sheetBackdrop').hidden = false;
  if (!$('beerAddForm').hidden) $('baName').focus();
}

$('btnAddBeer').addEventListener('click', openAddBeerSheet);
$('beerAddCancel').addEventListener('click', closeSheet);

// Add a beer: brewery picker uses the same brewery search
let baPickedBrewery = null;
attachSuggest(
  'baBrewery',
  'baSuggest',
  searchBreweries,
  (b) => `${b.name} — ${[b.city, b.state_province].filter(Boolean).join(', ')}`,
  (b, input) => {
    baPickedBrewery = b;
    input.value = `${b.name} (${[b.city, b.state_province].filter(Boolean).join(', ')})`;
  }
);
$('baBrewery').addEventListener('input', () => {
  baPickedBrewery = null; // typing again invalidates the pick
});

$('beerAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('baName').value.trim();
  $('baError').hidden = true;
  if (!name) return;
  if (!baPickedBrewery) {
    $('baError').hidden = false;
    $('baError').textContent = 'Pick the brewery from the suggestions so the beer lands in the right place.';
    return;
  }
  const btn = $('beerAddForm').querySelector('button[type=submit]');
  btn.disabled = true;
  const style = $('baStyle').value.trim(); // capture before reset() clears it
  try {
    await crowd.submitBeer({
      brewery: baPickedBrewery,
      beer_name: name,
      style,
    });
    $('beerAddForm').reset();
    const added = { beer_key: crowd.beerKey(baPickedBrewery.id, name), beer_name: name,
      style, brewery_id: baPickedBrewery.id, brewery_name: baPickedBrewery.name };
    baPickedBrewery = null;
    showToast(`🍺 ${name} added`);
    openBeerSheet(added);
  } catch (err) {
    $('baError').hidden = false;
    $('baError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- brewery website edit (signed-in) ----------
$('btnEditSite').addEventListener('click', () => {
  if (!crowd.authState()) return showToast('Sign in (Settings → Profile) to fix a website.');
  const f = $('editSiteForm');
  f.hidden = !f.hidden;
  if (!f.hidden) {
    $('esUrl').value = sheetBrewery?.website_url ?? '';
    $('esUrl').focus();
  }
});

$('editSiteCancel').addEventListener('click', () => {
  $('editSiteForm').hidden = true;
  $('editSiteForm').reset();
});

$('editSiteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = sheetBrewery;
  if (!b) return;
  let url = $('esUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  const btn = $('editSiteForm').querySelector('button');
  btn.disabled = true;
  try {
    await crowd.submitBreweryEdit(b.id, url);
    $('editSiteForm').hidden = true;
    showToast('Thanks — the website updates within a few hours.');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// app-first Untappd: try the app scheme, fall back to the web page if
// nothing grabbed the navigation (i.e. the app isn't installed)
$('actUntappd').addEventListener('click', (e) => {
  if ((localStorage.getItem(UNTAPPD_KEY) || 'web') !== 'app') return; // normal link
  if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) return; // schemes only work on mobile
  const web = e.currentTarget.href;
  e.preventDefault();
  let left = false;
  const onLeave = () => { left = true; };
  window.addEventListener('pagehide', onLeave, { once: true });
  document.addEventListener('visibilitychange', onLeave, { once: true });
  window.location.href = 'untappd://';
  setTimeout(() => {
    if (!left && document.visibilityState === 'visible') window.open(web, '_blank');
  }, 1200);
});
$('btnCityGo').addEventListener('click', cityGoAction);
$('btnCityDrop').addEventListener('click', toggleCityDrop);
for (const id of ['btnCityGo', 'btnCityDrop']) {
  $(id).addEventListener('blur', () =>
    setTimeout(() => { $('cityDrop').hidden = true; }, 200)
  );
}
renderCityDrop();

function addSavedCity(c) {
  const cities = loadSavedCities();
  if (!cities.some((x) => x.q.toLowerCase() === c.label.toLowerCase())) {
    // first city becomes home
    cities.push({ q: c.label, lat: c.lat, lng: c.lng, home: cities.length === 0 });
    saveSavedCities(cities);
  }
  $('cityAddInput').value = '';
  renderCities();
}
const addAC = attachCityAutocomplete($('cityAddInput'), addSavedCity);
$('cityAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const typed = $('cityAddInput').value.trim();
  if (!typed) return;
  const pick = addAC.first() ?? (await geocodeCities(typed))[0];
  addAC.close();
  addSavedCity(pick ?? { label: typed });
});
// ---------- missing brewery report ----------
// Posts straight to Firestore (crowd.js -> submitBreweryRequest) — no
// login, no GitHub issue. pipeline/sync-brewery-requests.js picks it up
// on the next 4-hourly refresh, geocodes it, and (unless it looks like a
// duplicate of something already listed) publishes it into
// pipeline/extra-breweries.json.

async function renderMissingBreweryGate() {
  const enabled = await crowd.crowdEnabled();
  const signedIn = !!crowd.authState();
  // adding a brewery shapes the shared catalog — sign-in required
  // (rule-enforced server-side too)
  $('missingForm').hidden = !enabled || !signedIn;
  $('mbGate').hidden = enabled && signedIn;
  $('mbGate').textContent = !enabled
    ? 'Brewery submissions aren’t turned on yet.'
    : 'Sign in (Settings tab → Profile) to add a brewery — takes a minute, just a name, email, and PIN.';
  $('mbAuthor').hidden = signedIn; // posts are auto-signed with the profile name
}

/* The add-brewery form lives in a bottom sheet — openable from the
   Breweries tab header or straight from the results page, no tab
   switch needed (sheets overlay any view). */
async function openAddBrewerySheet() {
  $('mbSuccess').hidden = true;
  $('mbError').hidden = true;
  $('mbDupe').hidden = true;
  mbPending = null;
  $('missingForm').reset();
  await renderMissingBreweryGate();
  $('sheet').hidden = true;
  $('beerSheet').hidden = true;
  $('addBeerSheet').hidden = true;
  $('addBrewerySheet').hidden = false;
  $('sheetBackdrop').hidden = false;
  if (!$('missingForm').hidden) $('mbName').focus();
}

$('btnAddBrewery').addEventListener('click', openAddBrewerySheet);
$('btnMissing').addEventListener('click', openAddBrewerySheet);
$('btnMissingTop').addEventListener('click', openAddBrewerySheet);
$('missingFormCancel').addEventListener('click', closeSheet);

async function findPossibleDuplicate(name, cityRaw) {
  try {
    const geo = (await geocodeCities(cityRaw))[0];
    if (!geo) return null; // couldn't geocode — never block on that alone
    let pool = state.breweries;
    // reuse the loaded list only if it plausibly covers this city;
    // otherwise (e.g. reached via Your Cities directly) fetch fresh
    if (!pool.length || !state.origin || haversineMiles(state.origin, geo) > 60) {
      await tapsReady;
      pool = prepare(await fetchByDist(geo.lat, geo.lng), geo);
    }
    for (const b of pool) {
      if (!b.hasCoords) continue;
      const miles = haversineMiles(geo, { lat: b.lat, lng: b.lng });
      if (miles <= 1 && namesLikelyMatch(name, b.name)) return { brewery: b, miles };
    }
    return null;
  } catch {
    return null; // network hiccup — never block a submission on this
  }
}

let mbPending = null; // stashed {name, city, site, author} once a dupe nudge is showing

async function submitBreweryRequest(name, city, site, author) {
  const btn = $('missingForm').querySelector('button[type=submit]');
  btn.disabled = true;
  $('mbError').hidden = true;
  try {
    await crowd.submitBreweryRequest({ name, city, website_url: site, author });
    $('missingForm').reset();
    $('missingForm').hidden = true;
    $('mbDupe').hidden = true;
    $('mbSuccess').hidden = false;
  } catch {
    $('mbError').hidden = false;
    $('mbError').textContent = "Couldn't send — try again in a minute.";
  } finally {
    btn.disabled = false;
  }
}

$('missingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('mbName').value.trim();
  const city = $('mbCity').value.trim();
  const site = $('mbSite').value.trim();
  const author = $('mbAuthor').value.trim();
  if (!name || !city) return; // website optional — it enables the auto-scan but isn't required

  const btn = $('missingForm').querySelector('button[type=submit]');
  btn.disabled = true;
  const match = await findPossibleDuplicate(name, city);
  btn.disabled = false;
  if (match) {
    const { brewery: dupe, miles } = match;
    mbPending = { name, city, site, author };
    $('mbDupeNote').textContent =
      `Looks like "${dupe.name}" (${[dupe.city, dupe.state_province].filter(Boolean).join(', ')}, ` +
      `${fmtMiles(miles)} from there) is already listed nearby. Is this a different location?`;
    $('mbDupe').hidden = false;
    $('mbDupe').scrollIntoView({ block: 'nearest' });
    return;
  }
  await submitBreweryRequest(name, city, site, author);
});

$('mbDupeYes').addEventListener('click', async () => {
  if (!mbPending) return;
  const { name, city, site, author } = mbPending;
  mbPending = null;
  $('mbDupe').hidden = true;
  await submitBreweryRequest(name, city, site, author);
});

$('mbDupeNo').addEventListener('click', () => {
  mbPending = null;
  $('mbDupe').hidden = true;
});

attachCityAutocomplete($('mbCity'), (c) => {
  $('mbCity').value = c.label;
});

$('sheetBackdrop').addEventListener('click', closeSheet);
$('sheet').querySelector('.grabber').addEventListener('click', closeSheet);

$('buildInfo').textContent = `Build ${APP_BUILD}`;

// hard update: refresh the service worker, drop caches, reload everything
$('btnUpdate').addEventListener('click', async () => {
  const btn = $('btnUpdate');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* still reload */
  }
  location.reload();
});

// the app always opens on the home page; the ★ home city is one tap away
// via the split button

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  // when a new version of the app takes over, load it immediately
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}
