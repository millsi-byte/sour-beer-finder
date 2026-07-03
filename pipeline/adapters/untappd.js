/* Untappd adapter — the anchor source (verified menus, structured styles).
   Four modes, tried best-first; adding a credential set as a repo secret
   lights up modes 1-2 with no code changes, but 3-4 are the ones that
   actually run today (Untappd's Consumer API is no longer self-serve —
   see the README):

   1. Untappd for Business API (secrets UNTAPPD_EMAIL + UNTAPPD_TOKEN):
      HTTP Basic with the account email and a read-only token
      (docs.business.untappd.com). Verified menus; only works for
      locations that specific business account can read.

   2. Untappd consumer API v4 (secrets UNTAPPD_CLIENT_ID +
      UNTAPPD_CLIENT_SECRET): GET /v4/venue/info/{venue_id}. Kept in
      case Untappd ever reopens Consumer API signup; there is currently
      no way to obtain these credentials for a third-party app.

   3. Keyless venue-page scrape (untappd_venue_url): Untappd's OWN public
      venue page (untappd.com/v/slug/id) needs no key, no account, no
      approval — any brewery whose site merely LINKS its Untappd page
      (far more common than embedding a widget) unlocks this way. Markup:
        <h5><a class="track-click" ...>Beer Name</a><em>Style</em></h5>
      (one hidden Handlebars template row always sits in the DOM and is
      filtered out — it is never a real beer).

   4. Keyless embed scrape (found_on + untappd_location_id): brewery
      sites embed their Untappd menu with a public script that injects
      markup like
        <h4 class="item-name">
          <a ...><span class="item-tap-number">1.</span>
                 <span id="...">Beer Name</span></a>
          <span class="item-style ..."><span class="item-category">Style</span></span>
        </h4>
      Rendering the page discovery found the widget on (found_on) and
      parsing those nodes yields the same menu without credentials.

   sources.json entry shape (written by discover.js):
     { "obdb_id": "...", "name": "...", "source": "untappd",
       "untappd_location_id": 12345,          // when an embed was found
       "untappd_venue_id": 987654,            // when a venue link was found
       "untappd_venue_url": "https://untappd.com/v/slug/987654",
       "found_on": "https://brewery.com/on-tap" } */

const { browserAvailable, fetchRendered } = require('../browser');
const { decodeEntities, collectBeers } = require('../lib');

const UFB = 'https://business.untappd.com/api/v1';
const V4 = 'https://api.untappd.com/v4';

function dedupe(beers) {
  const seen = new Set();
  return beers.filter((b) => !seen.has(b.name) && seen.add(b.name));
}

/* Untappd's OWN public venue page (untappd.com/v/slug/id) — no API key,
   no business account, no approval. Rendered markup per item:
     <h5><a class="track-click" ...>Beer Name</a><em>Style</em></h5>
   One hidden Handlebars template row ({{this.beer.beer_name}}) always
   sits in the DOM — filtered out, never a real beer. */
function parseVenuePage(html) {
  const beers = [];
  for (const [, name, style] of html.matchAll(
    /<h5>\s*<a class="track-click"[^>]*>\s*([^<]+?)\s*<\/a>\s*<em>([^<]*)<\/em>/g
  )) {
    if (name.includes('{{')) continue; // template placeholder row
    beers.push({ name: decodeEntities(name.trim()), style: decodeEntities(style.trim()) });
  }
  return dedupe(beers);
}

function parseEmbed(html) {
  const beers = [];
  // grid theme: <h4 class="item-name"><a>…<span id="…">Name</span></a>…
  for (const [, block] of html.matchAll(/<h4 class="item-name">([\s\S]*?)<\/h4>/g)) {
    const name = block.match(/<span id="[^"]*">([^<]+)<\/span>/)?.[1]?.trim();
    const style = block.match(/<span class="item-category">([^<]+)<\/span>/)?.[1]?.trim() ?? '';
    if (name) beers.push({ name: decodeEntities(name), style: decodeEntities(style) });
  }
  // table theme (Tree House): each item is a class="item-bg-color menu-item"
  // block with <span class="item">…<span id="…">Name</span> and .item-category
  for (const block of html.split(/class="item-bg-color menu-item"/).slice(1)) {
    const name = block.match(/<span class="item">[\s\S]*?<span id="[^"]*">([^<]+)<\/span>/)?.[1]?.trim();
    const style = block.match(/<span class="item-category">([^<]+)<\/span>/)?.[1]?.trim() ?? '';
    if (name) beers.push({ name: decodeEntities(name), style: decodeEntities(style) });
  }
  return dedupe(beers);
}

/* Collect beers only from parts of a v4 payload that are labeled as
   menus — checkin feeds and photos also contain beer objects, but they
   describe what someone drank, not what's on tap. */
function beersFromV4(data) {
  const menuish = [];
  (function walk(n) {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (/menu|on_tap|tap_?list/i.test(k)) menuish.push(v);
        else walk(v);
      }
    }
  })(data);
  return dedupe(collectBeers(menuish));
}

module.exports = async function untappd(src, env) {
  // 1) Untappd for Business — verified menus
  if (env.UNTAPPD_EMAIL && env.UNTAPPD_TOKEN && src.untappd_location_id) {
    try {
      const auth = 'Basic ' + Buffer.from(`${env.UNTAPPD_EMAIL}:${env.UNTAPPD_TOKEN}`).toString('base64');
      const get = async (p) => {
        const res = await fetch(`${UFB}${p}`, { headers: { Authorization: auth } });
        if (!res.ok) throw new Error(`UfB ${res.status} on ${p}`);
        return res.json();
      };
      const { menus } = await get(`/locations/${src.untappd_location_id}/menus`);
      const beers = [];
      for (const m of menus ?? []) {
        const { menu } = await get(`/menus/${m.id}?full=true`);
        for (const section of menu?.sections ?? []) {
          for (const item of section.items ?? []) {
            beers.push({ name: item.name, style: item.style || '' });
          }
        }
      }
      if (beers.length) return dedupe(beers);
    } catch (e) {
      console.warn(`  untappd UfB failed for ${src.name ?? src.obdb_id} (${e.message}) — falling back`);
    }
  }

  // 2) consumer API v4 — venue info, menu sections only
  if (env.UNTAPPD_CLIENT_ID && env.UNTAPPD_CLIENT_SECRET && src.untappd_venue_id) {
    try {
      const url =
        `${V4}/venue/info/${src.untappd_venue_id}` +
        `?client_id=${env.UNTAPPD_CLIENT_ID}&client_secret=${env.UNTAPPD_CLIENT_SECRET}`;
      const res = await fetch(url);
      if (res.ok) {
        const beers = beersFromV4(await res.json());
        if (beers.length) return beers;
      } else if (res.status === 429) {
        console.warn(`  untappd v4 rate-limited on ${src.name ?? src.obdb_id} — falling back`);
      } else {
        throw new Error(`v4 ${res.status}`);
      }
    } catch (e) {
      console.warn(`  untappd v4 failed for ${src.name ?? src.obdb_id} (${e.message}) — falling back`);
    }
  }

  // 3) keyless: Untappd's own public venue page — no key, no account,
  // works for any brewery whose site links its venue (far more breweries
  // do this than embed a widget)
  if (browserAvailable() && src.untappd_venue_url) {
    try {
      const html = await fetchRendered(src.untappd_venue_url, {
        timeoutMs: 25000,
        waitSelector: '.menu-item',
      });
      const beers = parseVenuePage(html);
      if (beers.length) return beers;
    } catch (e) {
      console.warn(`  untappd venue page failed for ${src.name ?? src.obdb_id} (${e.message}) — falling back`);
    }
  }

  // 4) keyless: render the page the widget lives on and parse the embed DOM
  if (browserAvailable() && src.found_on && src.untappd_location_id) {
    const html = await fetchRendered(src.found_on, {
      timeoutMs: 25000,
      waitSelector: '.item-name, .menu-item', // menu injects async — wait for it (grid or table theme)
    });
    return parseEmbed(html);
  }
  return null; // not configured for this environment / entry
};

module.exports.parseEmbed = parseEmbed;
module.exports.parseVenuePage = parseVenuePage;
module.exports.beersFromV4 = beersFromV4;
