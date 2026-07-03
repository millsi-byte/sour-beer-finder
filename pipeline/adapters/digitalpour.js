/* DigitalPour adapter. Same story as Taplist.io: menu embeds carry JSON,
   so fetch the configured embed/menu URL and extract generically.

   sources.json entry shape (discover.js fills this in when it spots the
   DigitalPour script on a brewery's site):
     { "obdb_id": "...", "name": "...", "source": "digitalpour",
       "embed_url": "https://mobile.digitalpour.com/..." } */

const { fetchText, beersFromEmbeddedJson, collectBeers } = require('../lib');

module.exports = async function digitalpour(src) {
  if (!src.embed_url) throw new Error('missing embed_url');
  const body = await fetchText(src.embed_url);
  try {
    return collectBeers(JSON.parse(body));
  } catch {
    return beersFromEmbeddedJson(body);
  }
};
