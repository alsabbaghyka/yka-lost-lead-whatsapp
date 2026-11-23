'use strict';
// Reading customer replies. isStop/isYes/isNo/isCall come from simulator.html;
// the opt-out keyword list, outbound guard and replies-export reader from index.html.
const { norm, cleanText, has } = require('./keywords');
const { mobileOf, parseDate, iso } = require('./mobile');

/* the engine's list (wider than the simulator's): errs towards suppressing */
const OPTOUT_KW = ['stop', 'stop all', 'unsubscribe', 'unsub', 'remove me', 'remove', 'opt out', 'optout', 'opt-out', 'cancel', 'quit', 'no more', "don't message", 'do not message', 'dont message', 'stop messaging', 'stop sending', 'توقف', 'ايقاف', 'إيقاف', 'الغاء', 'إلغاء', 'لا تراسلني'];
/* whole words, so "stopped by the showroom" is not an opt-out */
const isStop = text => has(norm(text), OPTOUT_KW);
const isYes = text => /^(yes|y|ok|okay|sure|نعم)(?![a-z])/i.test(String(text).trim());
const isNo = text => /^(no|nope|not interested|لا)(?![a-z])/i.test(String(text).trim());
const isCall = text => /\b(call|ring|phone me|contact me)\b|اتصل/i.test(String(text));
const clip = (t, n = 40) => { t = String(t).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* Our own Day 0 message ends with this line; a row holding it is one we sent. */
const OUTBOUND_MARK = 'reply stop to opt out';
const OUT_DIR_KW = ['out', 'outbound', 'outgoing', 'sent', 'business', 'business initiated', 'business_initiated', 'template', 'to customer', 'delivered', 'read'];
const TEXT_HDR = /message|text|body|reply|content|response|comment/i;
const DIR_HDR = /direction|dir|type|sender|source|inbound|outbound|way|status/i;
const MOB_HDR = /mobile|phone|number|msisdn|wa_?id|contact|from/i;

function longestTextColumn(rows, headers) {
  const look = rows.slice(0, 200), half = look.length / 2;
  let best = null, bestAvg = 15;
  headers.forEach(h => {
    const vals = look.map(r => r[h]);
    if (vals.filter(v => mobileOf(v)).length > half) return;
    if (vals.filter(v => v instanceof Date || parseDate(v)).length > half) return;
    let sum = 0, n = 0;
    vals.forEach(v => { if (v instanceof Date) return; const s = cleanText(v); if (s) { sum += s.length; n++; } });
    const avg = n ? sum / n : 0;
    if (avg > bestAvg) { bestAvg = avg; best = h; }
  });
  return best;
}

/** Opt-outs in a replies export (or a plain list of numbers). Returns {mobiles, dates, outbound, noText}. */
function parseOptoutRows(rows, headers) {
  const textKey = headers.find(h => TEXT_HDR.test(String(h))) || longestTextColumn(rows, headers);
  const dirKey = headers.find(h => DIR_HDR.test(String(h)));
  const mobKey = headers.find(h => MOB_HDR.test(String(h)));
  const dateKey = headers.find(h => /opted_out|date|time|received/i.test(String(h)));
  const mobiles = [], dates = {}; let outbound = 0;
  rows.forEach(r => {
    const text = norm(cleanText(textKey ? r[textKey] : ''));
    if (text.includes(OUTBOUND_MARK)) { outbound++; return; }
    if (dirKey && has(norm(cleanText(r[dirKey])), OUT_DIR_KW)) { outbound++; return; }
    if (textKey && !has(text, OPTOUT_KW)) return;
    const when = iso(dateKey ? parseDate(r[dateKey]) : null) || null;
    const add = m => { if (m && !mobiles.includes(m)) { mobiles.push(m); dates[m] = when; } };
    if (mobKey) add(mobileOf(r[mobKey])); else Object.values(r).forEach(v => add(mobileOf(v)));
  });
  return { mobiles, dates, outbound, noText: !textKey };
}

module.exports = { OPTOUT_KW, isStop, isYes, isNo, isCall, clip, OUTBOUND_MARK, parseOptoutRows, longestTextColumn };
