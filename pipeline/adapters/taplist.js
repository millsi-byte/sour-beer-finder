/* Taplist.io adapter. Their embeds are clean JSON under the hood — the
   configured embed/display URL is fetched and beers are pulled from
   whatever JSON the page carries (shapes vary per venue, so extraction
   is generic; see lib.collectBeers).

   sources.json entry shape (copy the embed URL the brewery's site uses —
   discover.js fills this in automatically when it spots the widget):
     { "obdb_id": "...", "name": "...", "source": "taplist",
       "embed_url": "https://app.taplist.io/embed/..." } */

const { fetchText, beersFromEmbeddedJson, collectBeers } = require('../lib');

module.exports = async function taplist(src) {
  if (!src.embed_url) throw new Error('missing embed_url');
  const body = await fetchText(src.embed_url);
  try {
    return collectBeers(JSON.parse(body)); // URL may serve raw JSON
  } catch {
    return beersFromEmbeddedJson(body); // or an HTML embed page
  }
};
