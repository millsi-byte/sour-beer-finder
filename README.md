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

### Enabling live data

1. Get [Untappd for Business](https://business.untappd.com) API credentials
   (read-only token).
2. Add repo secrets `UNTAPPD_EMAIL` and `UNTAPPD_TOKEN`.
3. Map breweries in `pipeline/sources.json`:
   ```json
   [
     { "obdb_id": "<open-brewery-db-id>", "name": "Green Bench",
       "source": "untappd", "untappd_location_id": 12345 },
     { "obdb_id": "<open-brewery-db-id>", "name": "Chalkboard Taproom",
       "source": "manual",
       "beers": [{ "name": "Peach Gose", "style": "Gose" }] }
   ]
   ```
4. Run the "Refresh tap lists" workflow (or wait for the nightly cron).

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

## Roadmap

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
