'use strict';
// Ported from lost-lead-engine/index.html (cleanMobile, parseDate, hashPct, mobileOf).

/** Bahrain mobile: 8 digits starting 3 or 6, after stripping 973 / 00973. Returns "+973XXXXXXXX" or null. */
function cleanMobile(v) {
  let d = String(v == null ? '' : v).replace(/\.0+$/, '').replace(/\D/g, '');
  if (d.startsWith('00973')) d = d.slice(5); else if (d.startsWith('973') && d.length === 11) d = d.slice(3);
  if (d.length === 8 && /^[36]/.test(d)) return '+973' + d;
  return null;
}

/* "30/06/2026" strips to 30062026 — eight digits starting 3, exactly the shape
   of a Bahrain mobile. Any column scanned for numbers has to skip dates first. */
const LOOKS_DATE = /^\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}/;
const mobileOf = v => (v instanceof Date || LOOKS_DATE.test(String(v == null ? '' : v).trim())) ? null : cleanMobile(v);

function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5));
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const d = new Date(Date.UTC(y, +m[2] - 1, +m[1])); return isNaN(d) ? null : d; }
  const d = new Date(s); return isNaN(d) ? null : d;
}
/** yyyy-mm-dd of a Date in UTC (dates parsed from files are UTC midnights). */
const iso = d => (d && !isNaN(d)) ? new Date(d).toISOString().slice(0, 10) : '';
function addDays(isoStr, n) { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }

/** FNV-1a of the mobile with the holdout key: the same customer always lands in the same group. */
function hashPct(str, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 100;
}

module.exports = { cleanMobile, mobileOf, LOOKS_DATE, parseDate, iso, addDays, hashPct };
