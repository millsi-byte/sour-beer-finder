/* DigitalPour adapter. Same story as Taplist.io: menu embeds carry JSON,
   so fetch the configured embed/menu URL and extract generically.

   sources.json entry shape (discover.js fills this in when it spots the
   DigitalPour script on a brewery's site):
     { "obdb_id": "...", "name": "...", "source": "digitalpour",
       "embed_url": "https://mobile.digitalpour.com/..." } */

const { beersFromEmbeddedJson, collectBeers } = require('../lib');
const { fetchSmart } = require('../browser');

module.exports = async function digitalpour(src) {
  if (!src.embed_url) throw new Error('missing embed_url');
  const body = await fetchSmart(src.embed_url);
  try {
    return collectBeers(JSON.parse(body));
  } catch {
    return beersFromEmbeddedJson(body);
  }
};
