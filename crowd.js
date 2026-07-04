/* Crowd layer: anonymous "Report & Review a Sour" — no accounts.
   Storage is Firebase Firestore's free tier, accessed via its plain REST
   API (no SDK). The whole feature stays hidden until data/crowd-config.json
   exists with a real project id + web API key (see README "Turning on
   drinker reports"). Moderation = deleting documents in the Firebase
   console; there is deliberately no in-app admin surface.

   Data model — one flat `reports` collection, three doc kinds:
     { kind:'report', brewery_id, brewery_name, beer_name, style?, rating?,
       author?, review?, created_at }
     { kind:'comment', report_id, brewery_id, author?, text, rating?, created_at }
     { kind:'vote',    report_id, brewery_id, vote:'still'|'gone', created_at }

   Reports never expire — reviews keep their value and beers come back on
   tap. "Gone" / "back on tap" are dated, named annotations on the report
   (a status trail), not votes, and never hide anything. The UI always
   shows dates so staleness stays honest. */

let cfg = null; // {project_id, api_key} or null when feature is off
let cache = null; // recent docs, fetched once per session

const cfgReady = fetch('data/crowd-config.json', { cache: 'reload' })
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => {
    if (c?.project_id && c?.api_key) cfg = c;
  })
  .catch(() => {});

function baseUrl() {
  return `https://firestore.googleapis.com/v1/projects/${cfg.project_id}/databases/(default)/documents`;
}

/* ---- Firestore REST encoding helpers ---- */
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    fields[k] = typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) };
  }
  return fields;
}

function fromDoc(doc) {
  const out = { _id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    out[k] = v.integerValue != null ? Number(v.integerValue) : v.stringValue;
  }
  return out;
}

/* ---- API ---- */
async function crowdEnabled() {
  await cfgReady;
  return !!cfg;
}

/* ================= PIN profiles (Firebase Auth over REST) =================
   The "PIN" is a Firebase email/password account whose password is a
   6+ digit PIN (Firebase's minimum password length is 6). No SDK, no
   popups (Google-style OAuth popups are flaky in iOS home-screen PWAs):
   plain fetch against identitytoolkit/securetoken, keyed by the same
   public api_key as Firestore. Forgot-PIN = Firebase's built-in reset
   email; the user sets a new PIN on Firebase's HOSTED page (opens in
   Safari — by design, nothing to build) and signs back in here. A reset
   revokes refresh tokens everywhere, which the wrapper turns into a
   graceful sign-out. Zero admin involvement anywhere. */

const AUTH_KEY = 's4s.auth';
const IDT = 'https://identitytoolkit.googleapis.com/v1';

function authState() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY));
  } catch {
    return null;
  }
}

function saveAuth(a) {
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a)); // one atomic blob
  else localStorage.removeItem(AUTH_KEY);
  window.dispatchEvent(new CustomEvent('s4s:authchange'));
}

/* Unified, enumeration-safe error copy. With email-enumeration
   protection ON (this project's default) Firebase merges wrong-PIN and
   unknown-email into INVALID_LOGIN_CREDENTIALS — never tell the user
   which one it was. */
function authErrorMessage(code) {
  if (/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD/.test(code))
    return "Email or PIN didn't match. Check both, or reset your PIN.";
  if (/EMAIL_EXISTS/.test(code)) return 'That email already has a profile — sign in instead (or reset your PIN).';
  if (/WEAK_PASSWORD/.test(code)) return 'PIN must be at least 6 digits.';
  if (/INVALID_EMAIL|MISSING_EMAIL/.test(code)) return "That doesn't look like an email address.";
  if (/TOO_MANY_ATTEMPTS/.test(code)) return 'Too many tries — wait a few minutes and try again.';
  if (/USER_DISABLED/.test(code)) return 'This profile has been disabled.';
  return "Couldn't reach the sign-in service — try again in a minute.";
}

async function idtCall(path, body) {
  await cfgReady;
  if (!cfg) throw new Error('crowd features not configured');
  const res = await fetch(`${IDT}/${path}?key=${cfg.api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.message || `HTTP_${res.status}`;
    const err = new Error(authErrorMessage(code));
    err.code = code;
    throw err;
  }
  return data;
}

async function signUp(email, pin, displayName) {
  const d = await idtCall('accounts:signUp', {
    email,
    password: pin,
    returnSecureToken: true,
  });
  const auth = {
    uid: d.localId,
    email,
    display_name: displayName,
    id_token: d.idToken,
    id_token_exp: Date.now() + (Number(d.expiresIn) - 60) * 1000,
    refresh_token: d.refreshToken,
  };
  saveAuth(auth);
  // display name + a verification email (purely a typo'd-email tripwire —
  // nothing is ever gated on verification). Both non-fatal.
  idtCall('accounts:update', { idToken: d.idToken, displayName, returnSecureToken: false }).catch(() => {});
  idtCall('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: d.idToken }).catch(() => {});
  return auth;
}

async function signIn(email, pin) {
  const d = await idtCall('accounts:signInWithPassword', {
    email,
    password: pin,
    returnSecureToken: true,
  });
  const auth = {
    uid: d.localId,
    email,
    display_name: d.displayName || email.split('@')[0],
    id_token: d.idToken,
    id_token_exp: Date.now() + (Number(d.expiresIn) - 60) * 1000,
    refresh_token: d.refreshToken,
  };
  saveAuth(auth);
  return auth;
}

/* Always resolves with the same neutral outcome — enumeration-safe. */
async function sendPinReset(email) {
  try {
    await idtCall('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email });
  } catch (e) {
    if (!/EMAIL_NOT_FOUND/.test(e.code || '')) throw e;
  }
}

function signOut() {
  saveAuth(null);
  localStorage.removeItem('s4s.me.cache');
  marksCache = null;
}

/* Single-flight token refresh: concurrent callers share one promise. */
let refreshInFlight = null;

async function freshIdToken() {
  const a = authState();
  if (!a) throw Object.assign(new Error('not signed in'), { code: 'NOT_SIGNED_IN' });
  if (a.id_token_exp - Date.now() > 5 * 60 * 1000) return a.id_token;
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.api_key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(a.refresh_token)}`,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = d?.error?.message || `HTTP_${res.status}`;
        if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_NOT_FOUND|USER_DISABLED/.test(code)) {
          // e.g. a PIN reset revoked this device's tokens — sign out gracefully
          signOut();
          window.dispatchEvent(new CustomEvent('s4s:signedout'));
        }
        throw Object.assign(new Error(authErrorMessage(code)), { code });
      }
      const cur = authState() ?? a;
      const next = {
        ...cur,
        id_token: d.id_token,
        id_token_exp: Date.now() + (Number(d.expires_in) - 60) * 1000,
        refresh_token: d.refresh_token || cur.refresh_token, // it can rotate
      };
      saveAuth(next);
      return next.id_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/* Fetch with a Bearer token; one forced refresh + retry on 401/403. */
async function authedFetch(url, opts = {}) {
  let token = await freshIdToken();
  const go = (t) =>
    fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${t}` } });
  let res = await go(token);
  if (res.status === 401 || res.status === 403) {
    const a = authState();
    if (a) {
      a.id_token_exp = 0; // force the refresh path
      saveAuth(a);
      token = await freshIdToken();
      res = await go(token);
    }
  }
  return res;
}

/* ============== user marks: favorites / had-it / wishlist / check-ins ====
   One owner-private, append-only event log (collection `user_marks`).
   {uid, kind: fav|unfav|had|unhad|wish|unwish|checkin, target_type, target_key,
    ...denormalized display fields, created_at}
   Current state = latest event per (toggle family, target_key); check-ins
   are a pure timeline. Nothing is ever updated, so a stale device can
   never clobber another device's marks — later timestamp simply wins. */

let marksCache = null; // this session's decoded events, newest last

function marksSnapshotSave() {
  try {
    localStorage.setItem(
      's4s.me.cache',
      JSON.stringify({ synced_at: new Date().toISOString(), events: marksCache })
    );
  } catch {
    /* storage full — offline display just degrades */
  }
}

async function fetchMyMarks(force = false) {
  const a = authState();
  if (!a || !(await crowdEnabled())) return [];
  if (marksCache && !force) return marksCache;
  try {
    const res = await authedFetch(`${baseUrl()}:runQuery?key=${cfg.api_key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'user_marks' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'uid' },
              op: 'EQUAL',
              value: { stringValue: a.uid },
            },
          },
          limit: 1000, // no orderBy: keeps us index-free; sorted client-side
        },
      }),
    });
    if (!res.ok) throw new Error(`marks fetch ${res.status}`);
    const rows = await res.json();
    marksCache = rows
      .filter((r) => r.document)
      .map((r) => fromDoc(r.document))
      .sort((x, y) => (x.created_at ?? '').localeCompare(y.created_at ?? ''));
    marksSnapshotSave();
    return marksCache;
  } catch {
    // offline / hiccup: serve the last-synced snapshot for display
    try {
      return JSON.parse(localStorage.getItem('s4s.me.cache'))?.events ?? [];
    } catch {
      return [];
    }
  }
}

/* {favs: Map(type|key -> event), had: Map(key -> event),
   wishes: Map(type|key -> event), checkins: [events]} */
function assembleMarks(events) {
  const favs = new Map();
  const had = new Map();
  const wishes = new Map();
  const checkins = [];
  for (const e of events) {
    const k = `${e.target_type}|${e.target_key}`;
    if (e.kind === 'fav' || e.kind === 'unfav') favs.set(k, e);
    else if (e.kind === 'had' || e.kind === 'unhad') had.set(k, e);
    else if (e.kind === 'wish' || e.kind === 'unwish') wishes.set(k, e);
    else if (e.kind === 'checkin') checkins.push(e);
  }
  for (const [k, e] of favs) if (e.kind === 'unfav') favs.delete(k);
  for (const [k, e] of had) if (e.kind === 'unhad') had.delete(k);
  for (const [k, e] of wishes) if (e.kind === 'unwish') wishes.delete(k);
  checkins.reverse(); // newest first
  return { favs, had, wishes, checkins };
}

async function myMarks(force) {
  return assembleMarks(await fetchMyMarks(force));
}

async function submitMark(kind, target_type, target_key, denorm = {}) {
  const a = authState();
  if (!a) throw Object.assign(new Error('sign in first'), { code: 'NOT_SIGNED_IN' });
  const saved = await createDoc('user_marks', {
    uid: a.uid,
    kind,
    target_type,
    target_key,
    ...denorm,
    created_at: new Date().toISOString(),
  });
  marksCache?.push(saved);
  marksSnapshotSave();
  return saved;
}

async function toggleFav(target_type, target_key, denorm) {
  const { favs } = await myMarks();
  const on = favs.has(`${target_type}|${target_key}`);
  await submitMark(on ? 'unfav' : 'fav', target_type, target_key, denorm);
  return !on;
}

/* Idempotent set — used by the local<->cloud favorites sync so a stale
   device can only ever ADD missing state, never flip someone else's. */
async function setFav(target_type, target_key, on, denorm) {
  const { favs } = await myMarks();
  if (favs.has(`${target_type}|${target_key}`) === on) return on;
  await submitMark(on ? 'fav' : 'unfav', target_type, target_key, denorm);
  return on;
}

async function toggleHad(target_key, denorm) {
  const { had } = await myMarks();
  const on = had.has(`beer|${target_key}`);
  await submitMark(on ? 'unhad' : 'had', 'beer', target_key, denorm);
  return !on;
}

async function toggleWish(target_type, target_key, denorm) {
  const { wishes } = await myMarks();
  const on = wishes.has(`${target_type}|${target_key}`);
  await submitMark(on ? 'unwish' : 'wish', target_type, target_key, denorm);
  return !on;
}

function checkIn(brewery) {
  return submitMark('checkin', 'brewery', brewery.id, {
    brewery_id: brewery.id,
    brewery_name: brewery.name,
    city: brewery.city,
    state: brewery.state_province,
  });
}

function clearMarksCache() {
  marksCache = null;
}

/* Writes never queue offline — connectivity is required, which makes
   sync conflicts structurally impossible (nothing stale ever uploads). */
function requireOnline() {
  if (!navigator.onLine) {
    throw Object.assign(new Error("You're offline — try again when connected."), {
      code: 'OFFLINE',
    });
  }
}

/* A PWA waking from the background (or a brief signal drop) sometimes
   fails a fetch at the network layer — a TypeError, distinct from a
   real HTTP error — surfaced by browsers as raw, unhelpful text
   ("Load failed" on Safari, "Failed to fetch" elsewhere). One quick
   retry clears most of these; anything left gets a friendlier message
   instead of that raw wording. */
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    await new Promise((r) => setTimeout(r, 500));
    try {
      return await fn();
    } catch {
      throw Object.assign(
        new Error("Couldn't reach the server — check your connection and try again."),
        { code: 'NETWORK' }
      );
    }
  }
}

/* Quota-proof read path: the pipeline publishes a static snapshot of
   the reports collection (data/crowd.json, free to serve, SW-cacheable,
   works offline); the session then delta-queries Firestore only for
   docs newer than the snapshot — read cost stays flat as data grows.
   Falls back to one full query when no snapshot exists yet. */
async function runReportsQuery(extra = {}) {
  const res = await fetch(`${baseUrl()}:runQuery?key=${cfg.api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: { from: [{ collectionId: 'reports' }], limit: 1000, ...extra },
    }),
  });
  if (!res.ok) throw new Error(`crowd fetch ${res.status}`);
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => fromDoc(r.document));
}

async function fetchRecent() {
  if (cache) return cache;
  let snap = null;
  try {
    const r = await fetch('data/crowd.json', { cache: 'reload' });
    if (r.ok) snap = await r.json();
  } catch {
    /* offline or missing — fall through */
  }
  if (snap?.generated_at && Array.isArray(snap.docs)) {
    cache = snap.docs;
    try {
      const fresh = await runReportsQuery({
        where: {
          fieldFilter: {
            field: { fieldPath: 'created_at' },
            op: 'GREATER_THAN',
            value: { stringValue: snap.generated_at },
          },
        },
      });
      const known = new Set(cache.map((d) => d._id));
      cache = cache.concat(fresh.filter((d) => !known.has(d._id)));
    } catch {
      /* snapshot alone still works (e.g. offline) */
    }
    return cache;
  }
  cache = await runReportsQuery();
  return cache;
}

/* Delete one of MY OWN docs (own uid only; rules enforce it server-side
   too). A real online delete — never queued, so no offline-conflict
   risk — used for self-serve takedown of a check-in/review/comment
   without any admin involvement. */
async function deleteDoc(collection, docId) {
  requireOnline();
  const a = authState();
  if (!a) throw Object.assign(new Error('sign in first'), { code: 'NOT_SIGNED_IN' });
  const res = await withRetry(() =>
    authedFetch(`${baseUrl()}/${collection}/${docId}?key=${cfg.api_key}`, { method: 'DELETE' })
  );
  if (!res.ok) throw new Error(`couldn't delete (${res.status})`);
  if (cache) cache = cache.filter((d) => d._id !== docId);
  if (marksCache) marksCache = marksCache.filter((d) => d._id !== docId);
  marksSnapshotSave();
}

/* Edit one of MY OWN reports/comments — text, author, or rating only
   (rules enforce both the uid match and the field allowlist server-
   side). A real online PATCH, never queued, so no offline-conflict
   risk. `patch` values of '' / undefined clear that field (Firestore
   treats a masked-but-absent field as "unset"). */
async function updateDoc(collection, docId, patch) {
  requireOnline();
  const a = authState();
  if (!a) throw Object.assign(new Error('sign in first'), { code: 'NOT_SIGNED_IN' });
  const mask = Object.keys(patch)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await withRetry(() =>
    authedFetch(`${baseUrl()}/${collection}/${docId}?key=${cfg.api_key}&${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFields(patch) }),
    })
  );
  if (!res.ok) throw new Error(`couldn't save (${res.status})`);
  const saved = fromDoc(await res.json());
  if (cache) cache = cache.map((d) => (d._id === docId ? { ...d, ...saved } : d));
  return saved;
}

async function createDoc(collection, data) {
  requireOnline();
  // signed-in writes carry a Bearer token so rules can verify the uid
  const doFetch = authState() ? authedFetch : fetch;
  const res = await withRetry(() =>
    doFetch(`${baseUrl()}/${collection}?key=${cfg.api_key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFields(data) }),
    })
  );
  if (!res.ok) throw new Error(`crowd save ${res.status}`);
  const saved = fromDoc(await res.json());
  // only 'reports' docs are ever read back client-side (brewery_requests
  // are read solely by the pipeline's sync script)
  if (collection === 'reports') cache?.push(saved);
  return saved;
}

/* ---- beer identity ----
   beer_key = brewery_id + '::' + slug(beer name) — same slug scheme as
   pipeline/brewery-lib.js (kept in sync by convention). Unifies scanned,
   drinker-reported, and user-added beers under one stable id, so reviews
   and marks attach to THE beer, not to one report of it. */
function slugName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function beerKey(breweryId, beerName) {
  return `${breweryId}::${slugName(beerName)}`;
}

/* Derive the key for any doc, including legacy docs written before
   beer_key existed (reports: from their own fields; comments/votes:
   resolved via their report_id by the callers below). */
function docBeerKey(d) {
  if (d.beer_key) return d.beer_key;
  if (d.beer_name && d.brewery_id) return beerKey(d.brewery_id, d.beer_name);
  return null;
}

/* Everything known about one beer across ALL its reports:
   reports (kind report/beer), comments, status trail, rating summary. */
function assembleBeer(docs, key) {
  const reportsById = new Map();
  const reports = [];
  for (const d of docs) {
    if ((d.kind === 'report' || d.kind === 'beer') && docBeerKey(d) === key) {
      reportsById.set(d._id, d);
      reports.push(d);
    }
  }
  const attached = (d) =>
    docBeerKey(d) === key || (d.report_id && reportsById.has(d.report_id));
  const comments = docs
    .filter((d) => d.kind === 'comment' && attached(d))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  const trail = docs
    .filter((d) => d.kind === 'vote' && attached(d))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  const ratings = [...reports, ...comments].map((d) => d.rating).filter(Boolean);
  const first = reports[0] ?? {};
  return {
    beer_key: key,
    beer_name: first.beer_name,
    style: reports.map((r) => r.style).find(Boolean),
    brewery_id: first.brewery_id,
    brewery_name: reports.map((r) => r.brewery_name).find(Boolean),
    reports: reports.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
    comments,
    trail,
    currentlyGone: trail.at(-1)?.vote === 'gone',
    avgRating: ratings.length
      ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10
      : null,
    ratingCount: ratings.length,
  };
}

/* Beer-grouped view of one brewery's drinker data (the brewery sheet's
   "Reported by drinkers" section is beer-centric: one row per beer). */
async function crowdBeersFor(breweryId) {
  if (!(await crowdEnabled())) return [];
  try {
    const docs = await fetchRecent();
    // include vote keys so a *scanned* beer marked on-tap/gone (vote only,
    // no report) still surfaces its drinker status on the tap-list row
    const keys = new Set(
      docs
        .filter((d) => (d.kind === 'report' || d.kind === 'beer' || d.kind === 'vote') && d.brewery_id === breweryId)
        .map(docBeerKey)
        .filter(Boolean)
    );
    return [...keys]
      .map((k) => assembleBeer(docs, k))
      .sort((a, b) => {
        // newest drinker activity first (report, else latest vote)
        const at = (x) => x.reports[0]?.created_at ?? x.trail.at(-1)?.created_at ?? '';
        return at(b).localeCompare(at(a));
      });
  } catch {
    return [];
  }
}

async function crowdBeer(key) {
  if (!(await crowdEnabled())) return null;
  try {
    return assembleBeer(await fetchRecent(), key);
  } catch {
    return null;
  }
}

/* All drinker-known beers (reported + user-added), one entry per key. */
async function crowdBeerCatalog() {
  if (!(await crowdEnabled())) return [];
  try {
    const docs = await fetchRecent();
    const keys = new Set(
      docs.filter((d) => d.kind === 'report' || d.kind === 'beer').map(docBeerKey).filter(Boolean)
    );
    return [...keys].map((k) => assembleBeer(docs, k));
  } catch {
    return [];
  }
}

/* "Add a beer" — the deliberate catalog action (signed-in only; rules
   enforce it too). Distinct from a tap report: no on-tap claim implied. */
function submitBeer({ brewery, beer_name, style }) {
  const a = authState();
  if (!a) throw Object.assign(new Error('sign in first'), { code: 'NOT_SIGNED_IN' });
  return createDoc('reports', {
    kind: 'beer',
    brewery_id: brewery.id,
    brewery_name: brewery.name,
    beer_name,
    beer_key: beerKey(brewery.id, beer_name),
    style,
    uid: a.uid,
    author: a.display_name,
    created_at: new Date().toISOString(),
  });
}

/* Website corrections: append-only brewery_edits docs; the 4-hourly
   pipeline applies the latest per brewery. Signed-in only. */
function submitBreweryEdit(breweryId, websiteUrl) {
  const a = authState();
  if (!a) throw Object.assign(new Error('sign in first'), { code: 'NOT_SIGNED_IN' });
  return createDoc('brewery_edits', {
    uid: a.uid,
    author: a.display_name,
    brewery_id: breweryId,
    field: 'website_url',
    value: websiteUrl,
    created_at: new Date().toISOString(),
  });
}

/* ---- domain helpers ---- */
function assemble(docs, breweryId) {
  const mine = docs.filter((d) => d.brewery_id === breweryId);
  const reports = mine.filter((d) => d.kind === 'report');
  return reports
    .map((rep) => {
      // chronological status trail: "gone" / "back on tap" annotations
      const trail = mine
        .filter((d) => d.kind === 'vote' && d.report_id === rep._id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        ...rep,
        comments: mine
          .filter((d) => d.kind === 'comment' && d.report_id === rep._id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at)),
        trail,
        currentlyGone: trail.at(-1)?.vote === 'gone',
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function crowdReportsFor(breweryId) {
  if (!(await crowdEnabled())) return [];
  try {
    return assemble(await fetchRecent(), breweryId);
  } catch {
    return []; // network/quota hiccup — the section just doesn't render
  }
}

/* breweryId -> count of drinker-known beers not currently marked gone.
   A beer counts if a drinker touched it in ANY way — reported it, added
   it, or marked it on-tap/gone. That last case matters: marking a
   *scanned* beer On Tap writes only a `vote` doc (no report), so vote
   keys must seed the set too, or a brewery whose only drinker signal is
   an on-tap vote would never show in the 👍 filter. `currentlyGone`
   then drops the ones whose latest vote is 'gone'. */
async function crowdCounts() {
  if (!(await crowdEnabled())) return {};
  try {
    const docs = await fetchRecent();
    const out = {};
    for (const id of new Set(docs.map((d) => d.brewery_id).filter(Boolean))) {
      const keys = new Set(
        docs
          .filter((d) => (d.kind === 'report' || d.kind === 'beer' || d.kind === 'vote') && d.brewery_id === id)
          .map(docBeerKey)
          .filter(Boolean)
      );
      const n = [...keys].filter((k) => !assembleBeer(docs, k).currentlyGone).length;
      if (n) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/* Signed-in users are auto-attributed (uid is rule-verified genuine);
   anonymous users keep the free-text name field. */
function identity(explicitAuthor) {
  const a = authState();
  return a ? { uid: a.uid, author: a.display_name } : { author: explicitAuthor };
}

function submitReport({ brewery, beer_name, style, rating, author, review }) {
  return createDoc('reports', {
    kind: 'report',
    brewery_id: brewery.id,
    brewery_name: brewery.name,
    beer_name,
    beer_key: beerKey(brewery.id, beer_name),
    style,
    rating,
    review,
    ...identity(author),
    created_at: new Date().toISOString(),
  });
}

function submitComment(report, { author, text, rating }) {
  return createDoc('reports', {
    kind: 'comment',
    report_id: report._id,
    beer_key: docBeerKey(report) ?? undefined,
    brewery_id: report.brewery_id,
    text,
    rating,
    ...identity(author),
    created_at: new Date().toISOString(),
  });
}

function submitVote(report, vote, author) {
  return createDoc('reports', {
    kind: 'vote',
    report_id: report._id,
    beer_key: docBeerKey(report) ?? undefined,
    brewery_id: report.brewery_id,
    vote, // 'gone' | 'still'
    ...identity(author),
    created_at: new Date().toISOString(),
  });
}

/* Brewery-add requests: a separate collection (not a 'kind' on `reports`)
   since its shape is unrelated — no brewery_id exists yet, that's the
   whole point. No lat/lng is ever sent from the client; geocoding a free-
   text city happens once, server-side, in pipeline/sync-brewery-requests.js
   (toFields() only round-trips strings/integers cleanly — floats would be
   mis-encoded — so keeping coordinates out of the client payload sidesteps
   that entirely). */
function submitBreweryRequest({ name, city, website_url, author }) {
  return createDoc('brewery_requests', {
    name,
    city,
    website_url,
    ...identity(author),
    created_at: new Date().toISOString(),
  });
}

window.crowd = {
  crowdEnabled,
  crowdReportsFor,
  crowdCounts,
  submitReport,
  submitComment,
  submitVote,
  submitBreweryRequest,
  // auth
  authState,
  signUp,
  signIn,
  signOut,
  sendPinReset,
  authedFetch,
  requireOnline,
  deleteDoc,
  updateDoc,
  // beers
  beerKey,
  crowdBeer,
  crowdBeersFor,
  crowdBeerCatalog,
  submitBeer,
  submitBreweryEdit,
  // user marks (favorites / had-it / wishlist / check-ins)
  myMarks,
  toggleFav,
  setFav,
  toggleHad,
  toggleWish,
  checkIn,
  clearMarksCache,
};
