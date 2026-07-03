/* Arryved adapter — brewery POS with online menus, heavily used by
   Florida taprooms (Angry Chair, Hidden Springs, Swamp Head…). The menu
   at commerce.arryved.com/location/{id} sits behind an age gate and an
   order-type chooser, then renders items as:

     <div data-testid="menu-item">
       <div class="nameText"><p><b>Riot Juice</b></p></div>
       <div class="descriptionText"><p>Pastry Sour with Blackberry…</p></div>

   The description doubles as the style string for the sour matcher.
   Includes packaged ("Cans") items as well as taps — both are what the
   taproom is pouring/selling right now.

   sources.json entry shape (written by discover.js):
     { "obdb_id": "...", "name": "...", "source": "arryved",
       "arryved_url": "https://commerce.arryved.com/location/Bafc0_Kn" } */

const { browserAvailable, fetchRendered } = require('../browser');
const { decodeEntities } = require('../lib');

const GATE_CLICKS = [/yes.*21|21\+|i.?m 21|over 21/i, /pickup|pick.?up|to.?go|takeout/i];

function parseMenu(html) {
  const beers = [];
  for (const item of html.split(/data-testid="menu-item"/).slice(1)) {
    let name = item.match(/class="nameText">[\s\S]*?<b>([^<]+)<\/b>/)?.[1]?.trim();
    let style = item.match(/class="descriptionText">[\s\S]*?<p[^>]*>([^<]+)<\/p>/)?.[1]?.trim() ?? '';
    if (name) beers.push({ name: decodeEntities(name), style: decodeEntities(style) });
  }
  const seen = new Set();
  return beers.filter((b) => !seen.has(b.name) && seen.add(b.name));
}

module.exports = async function arryved(src) {
  if (!src.arryved_url) throw new Error('missing arryved_url');
  if (!browserAvailable()) return null;
  const html = await fetchRendered(src.arryved_url, {
    timeoutMs: 25000,
    clickText: GATE_CLICKS,
    waitSelector: '[data-testid="menu-item"]',
  });
  return parseMenu(html);
};

module.exports.parseMenu = parseMenu;
