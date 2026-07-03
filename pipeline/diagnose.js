/* Coverage diagnostic: render every brewery site in an area and report
   ALL tap-list platform signatures present (not first-match like
   discovery), so we know which adapters/detectors are worth building.
   Log-only — commits nothing.

   Usage: node pipeline/diagnose.js "28.54,-81.38" */

const { fetchPage, closeBrowser } = (() => {
  const b = require('./browser');
  return { fetchPage: (u, t) => b.fetchSmart(u, { timeoutMs: t }), closeBrowser: b.closeBrowser };
})();

const OBDB = 'https://api.openbrewerydb.org/v1/breweries';

const PLATFORMS = {
  untappd: /business\.untappd\.com|utfb-images\.untappd/i,
  untappd_link_only: /untappd\.com\/(v|venue)\//i,
  beermenus: /beermenus\.com/i,
  taplist: /taplist\.io/i,
  digitalpour: /digitalpour\.com/i,
  taphunter_evergreen: /taphunter\.com|getevergreen\.com|evergreenhq/i,
  ontapp: /ontapp\.beer/i,
  arryved: /arryved\.com/i,
  toast: /toasttab\.com/i,
  square: /squareup\.com\/menu|square\.site/i,
  popmenu: /popmenu\.com|popmenucdn/i,
  getbento: /getbento\.com/i,
  singleplatform: /singleplatform|singlepage\.com/i,
  pdf_menu: /href="[^"]*\.pdf/i,
  instagram_only: /instagram\.com/i,
};

function menuLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = new Set();
  for (const [, href] of html.matchAll(/href="([^"#]+)"/gi)) {
    if (!/menu|tap|beer|drink|pour|brew|visit/i.test(href)) continue;
    if (/\.(pdf|jpe?g|png|webp)($|\?)|mailto:|tel:/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.host === base.host && u.href !== base.href) out.add(u.href);
    } catch { /* bad href */ }
  }
  return [...out].slice(0, 3);
}

async function main() {
  const center = process.argv[2];
  const params = new URLSearchParams({ per_page: '200', by_dist: center });
  const breweries = (await (await fetch(`${OBDB}?${params}`)).json()).filter((b) => b.website_url);
  console.log(`${breweries.length} breweries with websites near ${center}`);

  const tally = {}; // platform -> [brewery names]
  let unreachable = 0, nothing = 0;

  const queue = [...breweries];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      let html = '';
      try {
        html = await fetchPage(b.website_url, 12000);
        for (const link of menuLinks(html, b.website_url)) {
          try { html += await fetchPage(link, 9000); } catch { /* skip */ }
        }
      } catch {
        unreachable++;
        continue;
      }
      const hits = Object.entries(PLATFORMS).filter(([, re]) => re.test(html)).map(([k]) => k);
      const real = hits.filter((h) => !['instagram_only', 'pdf_menu'].includes(h));
      if (!real.length) nothing++;
      for (const h of hits) (tally[h] ??= []).push(b.name);
      console.log(`${b.name}: ${hits.join(', ') || '(none)'}`);
    }
  }));

  console.log('\n===== SUMMARY =====');
  console.log(`sites: ${breweries.length}, unreachable: ${unreachable}, no platform: ${nothing}`);
  for (const [k, names] of Object.entries(tally).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${k}: ${names.length}`);
  }
  await closeBrowser();
}

main().catch((e) => { console.error(e); process.exit(1); });
