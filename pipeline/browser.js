/* Headless-browser fetching for sites that block plain HTTP clients or
   render their pages with JavaScript (Wix/Squarespace/Cloudflare fronts
   403 non-browser TLS fingerprints, and JS-built pages carry no widget
   signatures in their raw HTML). Playwright is optional: workflows
   install it (see refresh-taps.yml); when absent, callers fall back to
   plain fetch. */

let pw = null;
try {
  pw = require('playwright');
} catch {
  /* not installed — browserAvailable() returns false */
}

let browserPromise = null;

function browserAvailable() {
  return !!pw;
}

async function getBrowser() {
  browserPromise ??= pw.chromium.launch({
    executablePath: process.env.S4S_CHROMIUM || undefined,
  });
  return browserPromise;
}

/* Load a page like a phone browser would and return the rendered DOM.
   waitSelector: wait (up to 12s) for a specific element instead of the
   fixed settle — tap-list widgets inject their menu via their own
   network fetch, which often lands after any fixed pause. */
async function fetchRendered(url, { timeoutMs = 20000, waitSelector = null, clickText = null } = {}) {
  if (!pw) throw new Error('playwright not installed');
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    // age gates, order-type choosers etc. — click through each in order
    for (const t of clickText ? [].concat(clickText) : []) {
      try {
        await page.getByText(t).first().click({ timeout: 4000 });
        await page.waitForTimeout(2500);
      } catch {
        /* step not present — fine */
      }
    }
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(500); // let the rest of the list fill in
    } else {
      await page.waitForTimeout(1500);
    }
    return await page.content();
  } finally {
    await ctx.close();
  }
}

async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
}

/* Plain fetch first (cheap), rendered browser fetch when the site blocks
   plain HTTP clients. */
async function fetchSmart(url, { timeoutMs = 10000 } = {}) {
  const { fetchText } = require('./lib');
  try {
    return await fetchText(url, { timeoutMs });
  } catch (e) {
    if (!browserAvailable()) throw e;
    return fetchRendered(url, { timeoutMs: timeoutMs + 10000 });
  }
}

module.exports = { browserAvailable, fetchRendered, fetchSmart, closeBrowser };
