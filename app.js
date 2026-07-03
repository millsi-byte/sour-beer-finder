/* SourSeeker v1 — nearby breweries via Open Brewery DB, plus live
   sour-on-tap data from data/taps.json (built nightly by pipeline/build.js,
   one adapter per tap-list source — see README roadmap). */

const API = 'https://api.openbrewerydb.org/v1/breweries';
const HIDDEN_TYPES = new Set(['closed', 'planning']);

const $ = (id) => document.getElementById(id);
const state = { origin: null, breweries: [], taps: null };

// ---------- tap data ----------
const tapsReady = fetch('data/taps.json', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { state.taps = d; })
  .catch(() => {});

function tapInfo(b) {
  return state.taps?.breweries?.[b.id] ?? null;
}

const SOURCE_LABELS = { untappd: 'via Untappd', manual: 'reported manually' };

function fmtAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
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
  const res = await fetch(`${API}?by_dist=${lat},${lng}&per_page=50`);
  if (!res.ok) throw new Error(`Open Brewery DB error ${res.status}`);
  return res.json();
}

async function fetchByCity(city, stateName) {
  const params = new URLSearchParams({ by_city: city, per_page: '50' });
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
  $('viewLocate').hidden = view !== 'locate';
  $('viewList').hidden = view !== 'list';
  $('spinner').hidden = view !== 'loading';
}

function renderList(title) {
  $('listTitle').textContent = title;
  const ul = $('breweryList');
  ul.innerHTML = '';
  if (!state.breweries.length) {
    ul.innerHTML = '<li class="footnote">No breweries found here. Try a nearby city.</li>';
  }
  state.breweries.forEach((b, i) => {
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
    li.addEventListener('click', () => openSheet(i));
    ul.appendChild(li);
  });
  show('list');
}

// ---------- detail sheet ----------
function openSheet(i) {
  const b = state.breweries[i];
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

  $('actMaps').href = b.hasCoords
    ? `https://maps.apple.com/?daddr=${b.lat},${b.lng}&q=${encodeURIComponent(b.name)}`
    : `https://maps.apple.com/?q=${encodeURIComponent(`${b.name} ${b.city || ''}`)}`;

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
        const raw = await fetchByDist(state.origin.lat, state.origin.lng);
        await tapsReady;
        state.breweries = prepare(raw, state.origin);
        renderList(`${state.breweries.length} breweries near you`);
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

async function cityFlow(q) {
  $('locateError').hidden = true;
  show('loading');
  try {
    const [city, st] = q.split(',').map((s) => s.trim()).filter(Boolean);
    if (!city) return fail('Enter a city name.');
    state.origin = null;
    const raw = await fetchByCity(city, st);
    await tapsReady;
    state.breweries = prepare(raw, null);
    renderList(`${state.breweries.length} breweries in ${city}`);
  } catch (e) {
    fail(`Couldn't load breweries: ${e.message}`);
  }
}

// ---------- wire up ----------
$('btnLocate').addEventListener('click', locateFlow);
$('cityForm').addEventListener('submit', (e) => {
  e.preventDefault();
  cityFlow($('cityInput').value);
});
$('btnNewSearch').addEventListener('click', () => show('locate'));
$('btnRefresh').addEventListener('click', () => {
  if (state.origin) locateFlow();
  else show('locate');
});
$('sheetBackdrop').addEventListener('click', closeSheet);
$('sheet').querySelector('.grabber').addEventListener('click', closeSheet);

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
}
