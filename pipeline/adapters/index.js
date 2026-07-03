/* Adapter registry. Each adapter is (sourceEntry, env) -> [{name, style}],
   or null when its credentials/config are absent. Adding a source is one
   new file here — the app never knows where data came from.

   v1.1 candidates (see README roadmap): beermenus.js (polite nightly
   scrape), taplist.js / digitalpour.js (clean JSON embeds), plus widget
   detection to auto-discover which source serves each brewery. */

module.exports = {
  untappd: require('./untappd'),
  manual: require('./manual'),
};
