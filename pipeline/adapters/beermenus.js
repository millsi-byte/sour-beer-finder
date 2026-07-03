/* BeerMenus adapter — the #2 tap-list platform (small taprooms and bottle
   shops Untappd misses). No free API, so this is polite scraping of the
   public place page: identified user-agent, nightly cadence, robots.txt
   respected before every run.

   sources.json entry shape:
     { "obdb_id": "...", "name": "...", "source": "beermenus",
       "beermenus_slug": "12345-green-bench-brewing" }

   Place pages list beers as <a href="/beers/...">Name</a> with a nearby
   style/ABV caption; parsing is tolerant of markup drift. */

const { fetchText, robotsDisallows } = require('../lib');

const ORIGIN = 'https://www.beermenus.com';

module.exports = async function beermenus(src) {
  if (!src.beermenus_slug) throw new Error('missing beermenus_slug');
  if (await robotsDisallows(ORIGIN, '/places')) {
    throw new Error('robots.txt disallows /places — skipping');
  }
  const html = await fetchText(`${ORIGIN}/places/${src.beermenus_slug}`);

  const beers = [];
  const anchors = [...html.matchAll(/<a[^>]+href="\/beers\/[^"]+"[^>]*>([^<]+)<\/a>/g)];
  for (const m of anchors) {
    const name = m[1].trim();
    if (!name) continue;
    // style/ABV caption is the first <p> after the beer link
    const win = html.slice(m.index, m.index + 600);
    const cap = win.match(/<p[^>]*>([^<]+)<\/p>/);
    beers.push({ name, style: cap ? cap[1].trim() : '' });
  }
  // de-dupe (pages repeat beers across "on tap" / "popular" sections)
  const seen = new Set();
  return beers.filter((b) => !seen.has(b.name) && seen.add(b.name));
};
