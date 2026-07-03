/* Manual adapter: beers listed inline in sources.json, for chalkboard-only
   taprooms that no platform serves. Placeholder for the v2 crowd layer —
   today the "crowd" is whoever edits sources.json.

   sources.json entry shape:
     { "obdb_id": "...", "name": "...", "source": "manual",
       "beers": [{ "name": "Peach Gose", "style": "Gose" }, ...] } */

module.exports = async function manual(src) {
  return (src.beers ?? []).map((b) =>
    typeof b === 'string' ? { name: b, style: b } : { name: b.name, style: b.style || '' }
  );
};
