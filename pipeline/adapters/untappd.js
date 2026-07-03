/* Untappd for Business adapter — the anchor source (verified menus,
   structured styles). Two modes:

   1. Credentialed (preferred): official API via HTTP Basic with the
      account email and a read-only token (docs.business.untappd.com),
      supplied as UNTAPPD_EMAIL / UNTAPPD_TOKEN repo secrets.

   2. Keyless: brewery sites embed their Untappd menu with a public
      script that injects markup like
        <h4 class="item-name">
          <a ...><span class="item-tap-number">1.</span>
                 <span id="...">Beer Name</span></a>
          <span class="item-style ..."><span class="item-category">Style</span></span>
        </h4>
      Rendering the page discovery found the widget on (found_on) and
      parsing those nodes yields the same menu without credentials.

   sources.json entry shape (written by discover.js):
     { "obdb_id": "...", "name": "...", "source": "untappd",
       "untappd_location_id": 12345,
       "found_on": "https://brewery.com/on-tap" } */

const { browserAvailable, fetchRendered } = require('../browser');

const BASE = 'https://business.untappd.com/api/v1';

function parseEmbed(html) {
  const beers = [];
  for (const [, block] of html.matchAll(/<h4 class="item-name">([\s\S]*?)<\/h4>/g)) {
    const name = block.match(/<span id="[^"]*">([^<]+)<\/span>/)?.[1]?.trim();
    const style = block.match(/<span class="item-category">([^<]+)<\/span>/)?.[1]?.trim() ?? '';
    if (name) beers.push({ name, style });
  }
  const seen = new Set();
  return beers.filter((b) => !seen.has(b.name) && seen.add(b.name));
}

module.exports = async function untappd(src, env) {
  const { UNTAPPD_EMAIL: email, UNTAPPD_TOKEN: token } = env;

  if (email && token) {
    const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    const get = async (p) => {
      const res = await fetch(`${BASE}${p}`, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`Untappd ${res.status} on ${p}`);
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
    return beers;
  }

  // keyless: render the page the widget lives on and parse the embed DOM
  if (browserAvailable() && src.found_on) {
    return parseEmbed(await fetchRendered(src.found_on, { timeoutMs: 25000 }));
  }
  return null; // not configured for this environment
};

module.exports.parseEmbed = parseEmbed;
