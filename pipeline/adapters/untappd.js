/* Untappd for Business adapter — the anchor source (verified menus,
   structured styles). Auth is HTTP Basic with the account email and a
   read-only API token (docs.business.untappd.com), supplied via the
   UNTAPPD_EMAIL / UNTAPPD_TOKEN repo secrets.

   sources.json entry shape:
     { "obdb_id": "...", "name": "...", "source": "untappd",
       "untappd_location_id": 12345 }

   Returns [{ name, style }] or null when credentials aren't configured. */

const BASE = 'https://business.untappd.com/api/v1';

module.exports = async function untappd(src, env) {
  const { UNTAPPD_EMAIL: email, UNTAPPD_TOKEN: token } = env;
  if (!email || !token) return null;

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
};
