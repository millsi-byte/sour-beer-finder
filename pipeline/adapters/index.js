/* Adapter registry. Each adapter is (sourceEntry, env) -> [{name, style}],
   or null when its credentials/config are absent. Adding a source is one
   new file here — the app never knows where data came from. */

module.exports = {
  untappd: require('./untappd'),
  beermenus: require('./beermenus'),
  taplist: require('./taplist'),
  digitalpour: require('./digitalpour'),
  manual: require('./manual'),
};
