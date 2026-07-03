# SourSeeker 🍺🍋

Mobile-first web app for sour beer hunters: launch it, see every brewery near
you, tap one, and jump straight to its tap list. Built to replace the
Google-Maps-then-click-every-website ritual.

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

## Roadmap

- **v1 — live tap lists.** Apply for a free [Untappd API key](https://untappd.com/api/docs).
  A scheduled GitHub Action (free; avoids Firebase Functions' paid Blaze
  requirement for outbound calls) resolves each brewery to its Untappd venue
  + verified menu, filters styles matching sour keywords (`sour`, `gose`,
  `berliner`, `lambic`, `gueuze`, `wild ale`, `brett`, `flanders`, `kettle`),
  and writes a cached JSON/Firestore snapshot the app reads instantly.
  Brewery cards then show a "🍋 3 sours on tap" badge.
- **v2 — crowd layer.** Firebase Auth + Firestore: followers confirm/flag
  what's actually pouring, favorites, "new sour at your favorites" alerts.
  Add parsers for BeerMenus / Taplist.io menus to widen coverage.

## Data sources

- Breweries: [Open Brewery DB](https://www.openbrewerydb.org/) — free, open,
  no key or rate limit.
- Tap lists (v1): Untappd official API — respect their terms and rate limits
  (~100 calls/hr); cache aggressively, never call it from the client.
