/* Search 4 Sour Beer (S4S) — nearby breweries via Open Brewery DB, plus live
   sour-on-tap data from data/taps.json (built nightly by pipeline/build.js,
   one adapter per tap-list source — see README roadmap). */

const API = 'https://api.openbrewerydb.org/v1/breweries';
const HIDDEN_TYPES = new Set(['closed', 'planning']);

const $ = (id) => document.getElementById(id);
const state = { origin: null, breweries: [], taps: null };

// bump on every release — shown under Check for updates on the Cities page
const APP_BUILD = '2026.07.03.23';

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

function saveSavedCities(cities) {
  localStorage.setItem(CITIES_KEY, JSON.stringify(cities));
}

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

function prepare(list, origin) {
  return list
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

// ---------- views ----------
function show(view) {
  state.view = view;
  $('btnRefresh').hidden = view !== 'status'; // refresh lives on the Data Status page only
  $('viewLocate').hidden = view !== 'locate';
  $('viewList').hidden = view !== 'list';
  $('viewCities').hidden = view !== 'cities';
  $('viewSettings').hidden = view !== 'settings';
  $('viewStatus').hidden = view !== 'status';
  $('spinner').hidden = view !== 'loading';
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

function renderChoiceBar(barId, key, options, fallback) {
  const bar = $(barId);
  bar.innerHTML = '';
  const cur = localStorage.getItem(key) || fallback;
  for (const [id, label] of options) {
    const btn = document.createElement('button');
    btn.className = 'radius-chip' + (id === cur ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      localStorage.setItem(key, id);
      renderChoiceBar(barId, key, options, fallback);
    });
    bar.appendChild(btn);
  }
}

function renderSettings() {
  renderChoiceBar('mapsBar', MAPS_KEY, MAP_PROVIDERS, 'apple');
  renderChoiceBar('untappdBar', UNTAPPD_KEY, [['web', 'Web page'], ['app', 'Untappd app']], 'web');
}

// ---------- list controls: radius, sort, sours-only ----------
const RADII = [10, 25, 50, 100, 'All'];
const RADIUS_KEY = 's4s.radius';
const SORT_KEY = 's4s.sort'; // 'sours' (default) | 'dist'
const ONLY_KEY = 's4s.soursOnly';
let radius = Number(localStorage.getItem(RADIUS_KEY)) || 'All';
let sortMode = localStorage.getItem(SORT_KEY) || 'sours';
let soursOnly = localStorage.getItem(ONLY_KEY) === '1';

function chip(label, active, onTap) {
  const btn = document.createElement('button');
  btn.className = 'radius-chip' + (active ? ' active' : '');
  btn.textContent = label;
  btn.addEventListener('click', onTap);
  return btn;
}

function renderControls() {
  const bar = $('radiusBar');
  bar.hidden = !state.origin; // no distances → nothing to filter
  if (!bar.hidden) {
    bar.innerHTML = '';
    RADII.forEach((r) => {
      bar.appendChild(
        chip(r === 'All' ? 'All' : `${r} mi`, r === radius, () => {
          radius = r;
          localStorage.setItem(RADIUS_KEY, r === 'All' ? '' : r);
          renderList();
        })
      );
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
    chip('\u{1F34B} only', soursOnly, () => {
      soursOnly = !soursOnly;
      localStorage.setItem(ONLY_KEY, soursOnly ? '1' : '');
      renderList();
    })
  );
}

function visibleBreweries() {
  let list = state.breweries;
  if (radius !== 'All' && state.origin) {
    list = list.filter((b) => b.miles != null && b.miles <= radius);
  }
  if (soursOnly) {
    list = list.filter((b) => tapInfo(b)?.sours.length);
  }
  if (sortMode === 'sours') {
    // stable sort: sours float to the top, distance order kept within groups
    list = [...list].sort(
      (a, c) => (tapInfo(c)?.sours.length ? 1 : 0) - (tapInfo(a)?.sours.length ? 1 : 0)
    );
  }
  return list;
}

// ---------- save-this-city star on results ----------
function currentCityCandidate() {
  if (state.lastSearch) {
    return { q: state.lastSearch.label, lat: state.lastSearch.lat, lng: state.lastSearch.lng };
  }
  if (state.lastCity) return { q: state.lastCity };
  return null; // geolocation searches have no city to save
}

function renderFavBtn() {
  const c = currentCityCandidate();
  const btn = $('btnFavCity');
  btn.hidden = !c;
  if (!c) return;
  const saved = loadSavedCities().some((x) => x.q.toLowerCase() === c.q.toLowerCase());
  btn.textContent = saved ? '★ Saved' : '☆ Save';
}

function toggleFavCity() {
  const c = currentCityCandidate();
  if (!c) return;
  let cities = loadSavedCities();
  const i = cities.findIndex((x) => x.q.toLowerCase() === c.q.toLowerCase());
  if (i >= 0) cities.splice(i, 1);
  else cities.push({ ...c, home: cities.length === 0 }); // first city becomes home
  saveSavedCities(cities);
  renderFavBtn();
  renderCityDrop();
}

function renderList(label) {
  if (label !== undefined) state.listLabel = label;
  const shown = visibleBreweries();
  $('listTitle').textContent =
    `${shown.length} ${shown.length === 1 ? 'brewery' : 'breweries'} ${state.listLabel}`;
  renderFavBtn();
  renderControls();
  const ul = $('breweryList');
  ul.innerHTML = '';
  if (!shown.length) {
    ul.innerHTML = state.breweries.length
      ? `<li class="footnote">${
          soursOnly
            ? 'No live sour data here yet — widen the radius or turn off \u{1F34B} only.'
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
    if (info?.sours.length) {
      const chip = li.querySelector('.sour-chip');
      chip.hidden = false;
      chip.textContent = `\u{1F34B} ${info.sours.length}`;
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
    ? `★ ${home.q}`
    : cities.length
      ? 'Your cities ▾'
      : 'Add your cities…';
  $('btnCityDrop').hidden = !cities.length;
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
    li.textContent = (c.home ? '★ ' : '') + c.q;
    onTap(li, () => {
      list.hidden = true;
      openCity(c);
    });
    list.appendChild(li);
  });
  const manage = document.createElement('li');
  manage.className = 'drop-manage';
  manage.textContent = '⚙︎ Manage cities…';
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
      <button class="city-star" aria-label="Set as home city"></button>
      <button class="city-remove" aria-label="Remove">&#x2715;</button>`;
    li.querySelector('.city-name').textContent = c.q;
    li.querySelector('.city-covered').hidden = !isCovered(c);
    const star = li.querySelector('.city-star');
    star.textContent = c.home ? '★' : '☆';
    star.title = c.home ? 'Home city' : 'Set as home city';
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
  $('dataAge').textContent = state.taps?.generated_at
    ? `Tap data last gathered ${fmtAgo(state.taps.generated_at)}.`
    : '';
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

async function renderScanStatus() {
  $('scanStatus').textContent = liveLine(await fetchPipelineState());
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
  renderScanStatus();
  show('cities');
}

// ---------- detail sheet ----------
function openSheet(b) {
  $('sheetName').textContent = b.name;
  const addr = [b.address_1, b.city, b.state_province].filter(Boolean).join(' · ');
  $('sheetSub').textContent = [addr, fmtMiles(b.miles)].filter(Boolean).join(' — ');

  const info = tapInfo(b);
  const badge = $('sourBadge');
  const body = $('sourBody');
  const list = $('sourList');
  list.hidden = true;
  list.innerHTML = '';
  if (!info) {
    badge.textContent = '\u{1F34B} Tap list';
    body.textContent = 'No live tap data for this brewery yet — check its Untappd menu:';
  } else if (!info.sours.length) {
    badge.textContent = '\u{1F34B} No sours right now';
    body.textContent = `Nothing sour among ${info.beer_count} beers on the current list · updated ${fmtAgo(info.fetched_at)}`;
  } else {
    const n = info.sours.length;
    badge.textContent = `\u{1F34B} ${n} sour${n > 1 ? 's' : ''} on tap`;
    body.textContent = `Updated ${fmtAgo(info.fetched_at)} · ${SOURCE_LABELS[info.source] ?? `via ${info.source}`}`;
    list.hidden = false;
    info.sours.forEach((s) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = s.name;
      li.appendChild(name);
      if (s.style && s.style !== s.name) {
        const style = document.createElement('span');
        style.className = 'style';
        style.textContent = ` — ${s.style}`;
        li.appendChild(style);
      }
      list.appendChild(li);
    });
  }

  $('actUntappd').href =
    `https://untappd.com/search?q=${encodeURIComponent(b.name)}&type=venues`;

  const site = b.website_url;
  $('actWebsite').hidden = !site;
  if (site) $('actWebsite').href = site;

  $('actMaps').href = directionsUrl(b);

  $('sheet').hidden = false;
  $('sheetBackdrop').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheetBackdrop').hidden = true;
}

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
        renderList('near you');
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
    renderList(`near ${label}`);
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
    state.breweries = prepare(raw, null);
    renderList(`in ${city}`);
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

$('btnNewSearch').addEventListener('click', () => show('locate'));
$('btnListHome').addEventListener('click', () => show('locate'));
$('btnFavCity').addEventListener('click', toggleFavCity);
// visible only on the Data Status page — re-fetches the live statuses
$('btnRefresh').addEventListener('click', statusFlow);
$('btnRefresh').hidden = true;
$('btnCities').addEventListener('click', citiesFlow);
$('btnCitiesBack').addEventListener('click', () => show('locate'));
$('brandHome').addEventListener('click', () => show('locate'));
$('btnSettings').addEventListener('click', () => {
  renderSettings();
  show('settings');
});
$('btnSettingsBack').addEventListener('click', () => show('locate'));
$('btnDataStatus').addEventListener('click', statusFlow);
$('btnStatusBack').addEventListener('click', citiesFlow);
$('btnStatusHome').addEventListener('click', () => show('locate'));

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
