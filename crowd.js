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

/* Writes never queue offline — connectivity is required, which makes
   sync conflicts structurally impossible (nothing stale ever uploads). */
function requireOnline() {
  if (!navigator.onLine) {
    throw Object.assign(new Error("You're offline — try again when connected."), {
      code: 'OFFLINE',
    });
  }
}

/* One query per session: every document. At this app's community size
   that is a small pile of JSON, and it powers both the list badges and
   every sheet without further roundtrips. */
async function fetchRecent() {
  if (cache) return cache;
  const res = await fetch(`${baseUrl()}:runQuery?key=${cfg.api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'reports' }],
        limit: 1000,
      },
    }),
  });
  if (!res.ok) throw new Error(`crowd fetch ${res.status}`);
  const rows = await res.json();
  cache = rows.filter((r) => r.document).map((r) => fromDoc(r.document));
  return cache;
}

async function createDoc(collection, data) {
  requireOnline();
  // signed-in writes carry a Bearer token so rules can verify the uid
  const doFetch = authState() ? authedFetch : fetch;
  const res = await doFetch(`${baseUrl()}/${collection}?key=${cfg.api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) }),
  });
  if (!res.ok) throw new Error(`crowd save ${res.status}`);
  const saved = fromDoc(await res.json());
  // only 'reports' docs are ever read back client-side (brewery_requests
  // are read solely by the pipeline's sync script)
  if (collection === 'reports') cache?.push(saved);
  return saved;
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

/* breweryId -> count of active (not likely-gone) reports, for list badges */
async function crowdCounts() {
  if (!(await crowdEnabled())) return {};
  try {
    const docs = await fetchRecent();
    const out = {};
    for (const id of new Set(docs.map((d) => d.brewery_id))) {
      const n = assemble(docs, id).filter((r) => !r.currentlyGone).length;
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
};
