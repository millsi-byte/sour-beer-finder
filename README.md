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

## Roadmap

Source menu, roughly in order of coverage-per-effort. Untappd alone covers
well past half of active taprooms; Untappd + BeerMenus + widget detection
should reach ~70–80% in metro areas, with the last stretch belonging to the
crowd layer.

- **v1.1 — BeerMenus + widget detection.** The single biggest coverage jump
  after Untappd. BeerMenus is the #2 tap-list platform (small taprooms and
  bottle shops Untappd misses); its brewery pages are public and structured
  but have no free API, so it's polite scraping — cache nightly, identify
  the app in the user-agent, respect robots.txt. Widget detection is the
  clever unlock: Open Brewery DB already gives each brewery's website, so
  the nightly Action fetches each homepage once and looks for embed
  signatures (`business.untappd.com/embeds`, `beermenus.com/widget`,
  `taplist.io`, DigitalPour scripts) to auto-discover which source serves
  each brewery — no hand-maintained mapping. A generic "beer-style keywords
  on the /menu page" fallback flags hand-coded menus as "possible sours,
  tap to verify".
- **v1.2 — Taplist.io / DigitalPour adapters.** Smaller players, but their
  embeds are clean JSON under the hood — trivially parseable when a brewery
  uses one.
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
