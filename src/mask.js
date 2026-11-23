'use strict';
// Mobiles never appear in full in logs or the audit trail.
const { cleanMobile } = require('./rules/mobile');

function maskMobile(m) {
  const c = cleanMobile(m) || String(m || '');
  return c.length >= 8 ? c.slice(0, c.startsWith('+973') ? 4 : 0) + '****' + c.slice(-4) : '****';
}
/* +973 / 00973 / 973 prefixed, or bare 8-digit numbers starting 3 or 6 */
const MOBILE_IN_TEXT = /(?:\+|00)?(?:973)?[ -]?[36]\d{3}[ -]?\d{4}(?!\d)/g;
const maskText = s => String(s == null ? '' : s).replace(MOBILE_IN_TEXT, m => (cleanMobile(m) ? maskMobile(m) : m));
/** Deep-mask any string inside a JSON-able value. */
function maskDeep(v) {
  if (typeof v === 'string') return maskText(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}
const log = (...a) => console.log(new Date().toISOString(), ...a.map(x => typeof x === 'string' ? maskText(x) : JSON.stringify(maskDeep(x))));

module.exports = { maskMobile, maskText, maskDeep, log };
