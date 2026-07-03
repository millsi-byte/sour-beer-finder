/* Craftpeak adapter — Craftpeak (now "Arryved web solutions") builds the
   websites of exactly the breweries sour hunters travel for: Wicked Weed
   (incl. the Funkatorium), Oxbow, Bissell Brothers, Rising Tide. Their
   optional "what's on tap" module renders a live tap list server-side on
   the brewery's /location/<taproom> pages:

     <div class="taplist module--wot-list">
       <div class="list-item ...">
         <h2 class="item-title h4">Cherry Morte</h2>
         ...
         <div class="item-descriptor ...">Cerise Morte- blended cherry sour</div>

   The descriptor line doubles as the style string for the sour matcher
   (Wicked Weed writes "blended cherry sour" right in it). Not every
   Craftpeak client turns the module on — Bissell and Rising Tide publish
   no draft list at all ("call us") — so the adapter reads every location
   page it was given and returns whatever taplists actually exist.

   sources.json entry shape (written by discover.js):
     { "obdb_id": "...", "name": "...", "source": "craftpeak",
       "craftpeak_locations": ["https://oxbowbeer.com/location/portland", ...] } */

const { browserAvailable, fetchRendered } = require('../browser');
const { decodeEntities } = require('../lib');

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTaplist(html) {
  const beers = [];
  // only read inside the tap-list module — item-title is also used for
  // shop products elsewhere on some pages
  for (const [, module] of html.matchAll(
    /class="taplist module--wot-list"([\s\S]*?)(?=class="taplist module--wot-list"|<footer|$)/g
  )) {
    for (const block of module.split(/class="list-item[ "]/).slice(1)) {
      const name = block.match(/class="item-title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/)?.[1];
      const style = block.match(/class="item-descriptor[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
      if (name) {
        beers.push({
          name: decodeEntities(stripTags(name)),
          style: decodeEntities(stripTags(style)),
        });
      }
    }
  }
  const seen = new Set();
  return beers.filter((b) => b.name && !seen.has(b.name) && seen.add(b.name));
}

module.exports = async function craftpeak(src) {
  if (!src.craftpeak_locations?.length) throw new Error('missing craftpeak_locations');
  if (!browserAvailable()) return null;
  const all = [];
  for (const url of src.craftpeak_locations) {
    try {
      const html = await fetchRendered(url, {
        timeoutMs: 25000,
        waitSelector: '.taplist .item-title',
      });
      all.push(...parseTaplist(html));
    } catch (e) {
      console.warn(`  craftpeak page failed (${url}): ${e.message}`);
    }
  }
  const seen = new Set();
  return all.filter((b) => !seen.has(b.name) && seen.add(b.name));
};

module.exports.parseTaplist = parseTaplist;
