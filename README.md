# Search 4 Sour Beer (S4S) 🍋

Mobile-first web app for sour beer hunters: launch it, see every brewery near
you, tap one, and jump straight to its tap list. Built to replace the
Google-Maps-then-click-every-website ritual.

The companion app to [@search4sourbeer](https://instagram.com/search4sourbeer)
on Instagram — branding (serif S4S lockup, sage green `#567a5e`) matches the
account's logo. Icons regenerate via `python3 make_icons.py` (Pillow).

Designed to look native on iOS when added to the home screen (Safari
standalone web-app mode). 100% free stack: static hosting + free public APIs.

## v0 — what works now

- **Use my location** → lists the 50 closest breweries (Open Brewery DB),
  sorted by distance, with type badges and mileage.
- **City search** fallback (`Tampa, FL`) when location is off.
- Tap a brewery → bottom sheet with **Untappd**, **Website**, and
  **Directions** (Apple Maps) deep links.
- Installable PWA: manifest, iOS meta tags, icons, network-first service
  worker (cache is offline fallback only).

No build step, no framework, no keys — plain HTML/CSS/JS.

## Running it

Any static server works:

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

Deploy free on **GitHub Pages** (Settings → Pages → deploy from branch) or
**Firebase Hosting** (`firebase init hosting && firebase deploy`).
Geolocation requires HTTPS (or localhost) — both hosts provide it.

On iPhone: open the URL in Safari → Share → **Add to Home Screen**.

## v1 — live tap lists (shipped: adapter architecture + Untappd)

A nightly GitHub Action (`.github/workflows/refresh-taps.yml`) runs
`pipeline/build.js`, which executes **one adapter per tap-list source**,
filters styles against the sour keyword matcher, and commits
`data/taps.json`. The app reads that snapshot instantly: brewery cards get a
"🍋 3" chip and the detail sheet lists the actual sours with a freshness
timestamp. The app never knows (or cares) where data came from.

**Adapter pattern from day one.** Each `pipeline/sources.json` entry carries
`source: untappd | manual` (later: `beermenus | taplist`) plus a
source-specific ID. Adding a source is one new file in `pipeline/adapters/`
— never a rewrite.

**Normalize styles at ingestion.** Sources spell styles differently
("Berliner-style Weisse" vs "Sour - Berliner Weisse"), so the matcher runs
on lowercase substrings (`sour`, `gose`, `berliner`, `lambic`, `gueuze`,
`wild`, `brett`, `flanders`, `kettle`) and the raw style string is kept so
users can judge edge cases like "Sour IPA".

### Adding an Untappd API key (if one ever becomes available)

Untappd's old self-serve Consumer API signup (client_id/client_secret)
is no longer open to new developers — API access now goes through
**Untappd for Business**, which isn't something a third-party app can
get for arbitrary breweries; it only covers venues whose *own* account
holder grants access. So in practice, for this app, there's no key to
go get. If that ever changes, turning one on is **just adding repo
secrets** — no code changes, no mapping edits — because both modes are
already wired into the adapter:

**Consumer API key** (`client_id` + `client_secret` pair, if Untappd
ever reopens this):
1. GitHub → this repo → **Settings → Secrets and variables → Actions →
   New repository secret**.
2. Add `UNTAPPD_CLIENT_ID` with the client id, and `UNTAPPD_CLIENT_SECRET`
   with the client secret.
3. Actions tab → **"Refresh tap data (fast)"** → Run workflow. Done —
   breweries whose sites link an untappd.com venue page (discovery
   already records their `untappd_venue_id`) start resolving through
   the API. Rate limit is 100 calls/hr; the 4-hourly refresh stays
   under it and falls back to keyless embed-scraping when throttled.

**Untappd for Business token** (only works for locations *that specific
business account* can read — e.g. if a brewery owner ever handed over
credentials):
1. Same place, add secrets `UNTAPPD_EMAIL` (account email) and
   `UNTAPPD_TOKEN` (read-only API token).
2. Run **"Refresh tap data (fast)"**.

**The real, permanent path is keyless — and there are two of them:**

1. **Venue-page scrape** (discovered 2026-07-03, biggest lever): any
   brewery whose site merely *links* its Untappd page (`untappd.com/v/
   slug/id`) unlocks a full menu — Untappd's own venue page is public
   HTML, no key or account required, and it resolves by the numeric id
   alone (the slug is cosmetic). This is far more common than a brewery
   embedding Untappd's widget on their own site, which is what the
   adapter was previously limited to.
2. **Embed-widget scrape**: brewery sites that DO embed Untappd's menu
   widget get parsed directly off the rendered page.

Both are keyless and are what's actually covering the app's live data
today (see the throttle-mitigation note below). Coverage is still
capped by how many breweries publish *any* machine-readable tap
list at all — see "Known coverage gaps" below for the honest number.

Manual entries for chalkboard-only taprooms still work via
`pipeline/sources.json`:
```json
{ "obdb_id": "<open-brewery-db-id>", "name": "Chalkboard Taproom",
  "source": "manual",
  "beers": [{ "name": "Peach Gose", "style": "Gose" }] }
```

## Turning on drinker reports (the crowd layer)

"🍋 Report & Review a Sour" on every brewery page: anonymous reports
(no login) with an optional name, star rating, and review; comments;
and dated "gone / back on tap" notes. Reports never expire — reviews
keep their value and beers come back — and drinker data is always
badged 👥 (vs 🍋 for scraped menus) with visible dates, since people
reports go stale faster than scraped ones. This is the only data
source for breweries that publish no tap list at all (Bissell, Rising
Tide, Spyglass…).

The feature is invisible until you create the (free) storage and
paste its config. One-time setup, ~5 minutes, no credit card:

1. Go to [console.firebase.google.com](https://console.firebase.google.com),
   sign in with any Google account, **Create a project** (name it
   `s4s`, disable Analytics).
2. In the project: **Build → Firestore Database → Create database** →
   Start in **production mode** → pick a US location.
3. **Rules** tab → replace everything with the rules below → Publish:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /reports/{doc} {
         allow read: if true;
         allow create: if request.resource.data.keys().hasOnly(
             ['kind','brewery_id','brewery_name','beer_name','style',
              'rating','author','review','report_id','text','vote',
              'created_at'])
           && request.resource.data.kind in ['report','comment','vote'];
         allow update, delete: if false;
       }
     }
   }
   ```
4. Project settings (gear icon) → **General** → "Your apps" → the
   `</>` (web) icon → register app (nickname `s4s`, no hosting). Copy
   the `projectId` and `apiKey` values it shows.
5. In this repo, create the file `data/crowd-config.json`
   (GitHub → Add file) containing:
   ```json
   { "project_id": "YOUR_PROJECT_ID", "api_key": "YOUR_API_KEY" }
   ```
   Commit — the app lights up on the next deploy. (This key is meant
   to be public; the rules above are what limit writes.)

**Moderation / admin delete:** open the Firebase console → Firestore
→ `reports` collection → click the offending document → delete. Your
Google login is the admin login; there is nothing else to run.

## Manually adding breweries (Open Brewery DB gaps)

The brewery list comes from Open Brewery DB, which is missing some major
breweries (Tree House!). `pipeline/extra-breweries.json` is the hand-kept
supplement: entries carry `id` (`x-…` so they never collide with OBDB ids),
`name`, `city`, `state`, `lat`, `lng`, `website_url`, and optionally
`menu_url` — set it for multi-location sites (Tree House) so discovery
scans THIS location's tap-list page instead of whichever location the
homepage links first. They flow everywhere automatically:

- `build.js` publishes them inside `data/taps.json` (`extra_breweries`),
  and the app injects them into search results — with real distances,
  radius filtering, and 🍋 badges — whenever they're within 150 mi of the
  search point (or match a searched city by name).
- `discover.js` scans their websites for tap-list widgets on **every**
  run, so a new entry joins the tap-list scans the very next night.

Three ways an entry gets in:

1. **The app's "Missing a brewery?" form** (results-page footer link, and
   on Your Cities): fills a GitHub issue titled `Add brewery: …` with
   `Name:` / `City:` / `Website:` lines. The **Add brewery** workflow
   parses it, geocodes the city (Open-Meteo), appends the entry, updates
   the published snapshot, comments, and closes the issue. Owner-filed
   issues run instantly; anyone else's waits for a maintainer to add the
   `approved` label.
2. `node pipeline/add-brewery.js "Name" "City, ST" [website]` locally.
3. Edit `pipeline/extra-breweries.json` by hand.

## v1.1 — all pipelines (shipped)

Every planned source now has an adapter; coverage estimate for
Untappd + BeerMenus + widget detection is ~70–80% of metro-area taprooms.

- **BeerMenus** (`beermenus`) — #2 platform; polite scraping of public
  place pages (identified user-agent, nightly cadence, robots.txt checked
  before every run). Keyless — works today.
- **Taplist.io / DigitalPour** (`taplist`, `digitalpour`) — their embeds
  are clean JSON under the hood; adapters fetch the embed URL and extract
  generically. Keyless.
- **Widget detection** (`pipeline/discover.js` + the "Discover tap-list
  sources" workflow) — fetches each area brewery's homepage and its
  menu/tap-list subpages (websites come free from Open Brewery DB) and
  looks for embed signatures (`business.untappd.com/locations/…`,
  `beermenus.com/places/…`, `taplist.io`, `digitalpour.com`), auto-writing
  mappings into `sources.json` instead of maintaining them by hand.
- **Covered areas** (`pipeline/areas.json`) — the managed list of places
  the nightly job re-scans and refreshes. Add an area by running the
  "Discover tap-list sources" workflow (center `lat,lng` + label) — it
  scans immediately and persists the area for every night after — or by
  editing `areas.json` directly. The app's **Your cities** page (⚙) lets
  each user keep their own city list with a starred home city (stored on
  device) and shows which areas have live data.
- **Untappd** (`untappd`) — the anchor source, still gated on
  `UNTAPPD_EMAIL` / `UNTAPPD_TOKEN` secrets (see "Enabling live data").

## Known coverage gaps (the honest number)

As of 2026-07-03, a fresh discovery scan of the Boston metro (188
breweries with websites) found a widget or venue-link signature on
**1** of them organically (plus 3 hand-added extras). That is the real
bottleneck — most breweries simply don't publish a machine-readable
tap list anywhere on their own website (Instagram-only, chalkboard, or
a third-party platform this pipeline doesn't parse yet). National
coverage sits around 4-5% of scanned breweries, concentrated on
whichever platforms are supported (Untappd, Arryved, BeerMenus,
Taplist.io, DigitalPour).

This means: for any specific city, most breweries will show up in the
app with location/directions but genuinely have no live sour data yet
— not a bug, a coverage gap. Closing it further needs either more
platform adapters (Craftpeak and Toast are the two biggest known
remaining platforms — see Roadmap) or the crowd-reporting layer (v2).

## Roadmap

The proven loop for adding any source: run the **Diagnose area coverage**
workflow to tally platform signatures, use **Debug - dump rendered page**
to capture a real page's markup on the `debug-dump` branch (fetch it,
inspect), write the parser against that reality with a fixture test,
then add the detection signature to `pipeline/discover.js` and the
adapter to `pipeline/adapters/`.

- **Craftpeak adapter — SHIPPED 2026-07-03.** Detection fingerprint is
  `craftpeak.site` / `craftpeak-cooler` assets; the live tap list is the
  server-rendered "wot-list" module on /location/<taproom> pages (the
  /beers page is the catalog, not what's pouring). Verified against real
  dumps: Funkatorium 32 beers / 13 sours, Oxbow Portland 51 beers /
  17 sours (after teaching the sour matcher brewer-speak:
  mixed-fermentation, spontaneous, tart). Caveat learned the honest way:
  not every Craftpeak client turns the module on — Bissell Brothers and
  Rising Tide publish no draft list anywhere ("call us"), so they're
  crowd-layer candidates, not adapter targets.
- **Toast — investigated and REJECTED 2026-07-03.** The platform counts
  in diagnostics (27 in Portland ME etc.) are food-ordering links, not
  tap lists: Goodfire's Toast page carries wings, sandwiches, and
  seltzers — zero draft beer. Building a Toast adapter would harvest
  chicken sandwiches. Do not revisit without first checking a specific
  brewery's Toast page actually lists draft beer.
- **Known extraction gaps to debug** (dump the page, adjust gate/wait):
  Foulmouthed Brewing + Swamp Head + Sailfish (arryved, 0 beers —
  likely age-gate wording variants beyond GATE_CLICKS), Taplist.io
  venue pages (403 to plain fetch, 0 beers rendered), DigitalPour
  (4 sources, 0 beers).
- **Untappd embed throttling (diagnosed 2026-07-03).** Untappd
  rate-limits the runner's IP a few minutes into every run: the first
  ~60 embed renders return menus, everything after times out at the
  12s waitSelector and parses to 0. Mitigated in build.js — source
  order is shuffled per run and an empty/failed read keeps the
  previous run's menu (older fetched_at) instead of wiping it — so
  coverage accumulates across the 4-hourly refreshes. A real fix is
  an Untappd API key (see "Adding an Untappd API key").
- **Spyglass Brewing (Nashua)** — Squarespace site behind an
  "over 21?" age gate; behind it there's no tap-list widget, and the
  site itself says to watch Facebook for beer availability. No
  machine-readable menu → crowd layer (v2) is the only path.
- **v1.2 — keyword fallback.** For breweries with no widget, scan their
  /menu or /beer page for beer-style keywords and flag "possible sours,
  tap to verify" — lower confidence, wider net.
- **v2 — crowd layer.** Chalkboard-only breweries will never be
  machine-readable; the crowd is the only "API" for those. Firebase Auth +
  Firestore: a "confirm what's pouring" button with a freshness timestamp
  ("reported 2 days ago"), favorites, "new sour at your favorites" alerts.
  (Today the `manual` adapter covers these via `sources.json` edits.)

## Data sources

- Breweries: [Open Brewery DB](https://www.openbrewerydb.org/) — free, open,
  no key or rate limit.
- Tap lists: Untappd for Business API (anchor source) — respect their terms
  and rate limits; cache aggressively (nightly), never call it from the
  client. BeerMenus / Taplist.io / DigitalPour adapters planned (see
  Roadmap).
