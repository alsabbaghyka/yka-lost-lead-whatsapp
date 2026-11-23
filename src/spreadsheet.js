'use strict';
// Reading uploaded .xlsx / .csv files — the engine's readFile(), on the server.
// SheetJS 0.20.3 is vendored and hash-checked (vendor/xlsx.js).
const XLSX = require('../vendor/xlsx.js');
const { cleanMobile, iso } = require('./rules/mobile');
const { norm, cleanText } = require('./rules/keywords');
const { FIELDS } = require('./rules/engine');

const MAX_BYTES = 25 * 1024 * 1024;

function readSpreadsheet(buf, fileName = '') {
  if (buf instanceof Uint8Array && !Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('Empty file'), { status: 400 });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('File is larger than 25 MB'), { status: 413 });
  /* CSV is decoded as UTF-8 here; read as bytes SheetJS applies its own codepage and Arabic turns to mojibake */
  const csvLike = /\.(csv|txt|tsv)$/i.test(fileName);
  let wb;
  try {
    wb = csvLike
      ? XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''), { type: 'string', cellDates: true, dense: false })
      : XLSX.read(buf, { type: 'buffer', cellDates: true, dense: false, cellFormula: false, cellHTML: false });
  } catch (e) { throw Object.assign(new Error("That file couldn't be read. Save it as .xlsx or .csv with headers in the first row."), { status: 400 }); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], names: [], headerless: false };
  // CRM exports often declare a range of a million empty rows: shrink it to the cells that exist
  let maxR = 0, maxC = 0;
  Object.keys(ws).forEach(k => { if (k[0] === '!') return; const a = XLSX.utils.decode_cell(k); if (a.r > maxR) maxR = a.r; if (a.c > maxC) maxC = a.c; });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false }).filter(r => r.some(v => v !== '' && v != null));
  if (!grid.length) return { rows: [], names: [], headerless: false };
  const first = grid[0].map(v => norm(v));
  const kwHits = first.filter(h => h && FIELDS.some(f => f.kw.some(k => h.includes(k)))).length;
  const hasMobile = grid[0].some(v => cleanMobile(v));
  const headerless = hasMobile || kwHits < 2;
  const width = Math.max(...grid.map(r => r.length));
  const letter = i => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + i % 26);
  let names, body;
  if (headerless) {
    names = Array.from({ length: width }, (_, i) => {
      const ex = grid.map(r => r[i]).find(v => v !== '' && v != null);
      const exs = ex instanceof Date ? iso(ex) : cleanText(ex).slice(0, 18);
      return `Col ${letter(i)}${exs ? ' · ' + exs : ''}`;
    });
    body = grid;
  } else {
    names = grid[0].map((h, i) => cleanText(h) || `Col ${letter(i)}`);
    for (let i = names.length; i < width; i++) names.push(`Col ${letter(i)}`);
    body = grid.slice(1);
  }
  const seen = {}; names = names.map(n => seen[n] ? `${n} (${++seen[n]})` : (seen[n] = 1, n));
  // Object.fromEntries defines own data properties, so a header named "__proto__" stays an ordinary key
  const rows = body.map(r => Object.fromEntries(names.map((n, i) => [n, r[i] == null ? '' : r[i]])));
  return { rows, names, headerless };
}

module.exports = { readSpreadsheet, MAX_BYTES };
