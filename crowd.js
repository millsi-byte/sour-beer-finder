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
  const res = await fetch(`${baseUrl()}/${collection}?key=${cfg.api_key}`, {
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

function submitReport({ brewery, beer_name, style, rating, author, review }) {
  return createDoc('reports', {
    kind: 'report',
    brewery_id: brewery.id,
    brewery_name: brewery.name,
    beer_name,
    style,
    rating,
    author,
    review,
    created_at: new Date().toISOString(),
  });
}

function submitComment(report, { author, text, rating }) {
  return createDoc('reports', {
    kind: 'comment',
    report_id: report._id,
    brewery_id: report.brewery_id,
    author,
    text,
    rating,
    created_at: new Date().toISOString(),
  });
}

function submitVote(report, vote, author) {
  return createDoc('reports', {
    kind: 'vote',
    report_id: report._id,
    brewery_id: report.brewery_id,
    vote, // 'gone' | 'still'
    author,
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
    author,
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
};
