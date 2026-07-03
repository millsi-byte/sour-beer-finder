/* Style normalization: sources spell styles differently ("Berliner-style
   Weisse" vs "Sour - Berliner Weisse"), so match lowercase substrings and
   keep the raw style string so users can judge edge cases like "Sour IPA". */

const SOUR_KEYWORDS = [
  'sour',
  'gose',
  'berliner',
  'lambic',
  'gueuze',
  'geuze',
  'wild',
  'brett',
  'flanders',
  'kettle',
];

function isSourStyle(style) {
  const s = String(style || '').toLowerCase();
  return SOUR_KEYWORDS.some((k) => s.includes(k));
}

module.exports = { SOUR_KEYWORDS, isSourStyle };
