'use strict';
// Ported from lost-lead-engine/index.html. A keyword matches only at word
// boundaries: "dp" must not fire on "dpt", "busy" must not fire on "business".
// A trailing * drops the closing boundary (a stem); without it a plural s/es is
// allowed. \b knows ASCII only, so Arabic keywords fall back to a substring test.

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const cleanText = v => String(v == null ? '' : v).replace(/_x000D_/gi, ' ').replace(/\s+/g, ' ').trim();

const KW_RX = new Map();
function kwRegex(k) {
  let rx = KW_RX.get(k);
  if (!rx) {
    const stem = k.endsWith('*'), body = (stem ? k.slice(0, -1) : k).trim();
    const lit = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    rx = new RegExp('(?:^|[^a-z0-9])' + lit + (stem ? '' : '(?:es|s)?(?![a-z0-9])'), 'i');
    KW_RX.set(k, rx);
  }
  return rx;
}
const ASCII_ONLY = /^[\x00-\x7F]*$/;
const hasKw = (text, k) => ASCII_ONLY.test(k) ? kwRegex(k).test(text) : String(text).includes(k.replace(/\*$/, ''));
const has = (text, list) => list.some(k => hasKw(text, k));

module.exports = { norm, cleanText, kwRegex, hasKw, has, ASCII_ONLY };
