'use strict';
// The CRM lost-lead export layout the business actually shares (seen 23 Nov 2026):
// Credate, Userid, User Name, Cont Group, Code, Desc, Time, MKmagic, Custname, Company Name,
// Mobile, Strength, Description, Orign, Orign Desc, Notes1, Notes2, Notes3, Email, FOC, Desc,
// FollDate, Time, Contdate, Locn, ContSeq, Orig, Follexec, Vehmodel, Source.
// The reason is a free-text note split across Notes1..Notes3. All rows below are made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../vendor/xlsx.js');
const { readSpreadsheet } = require('../src/spreadsheet');
const { detect, runEngine } = require('../src/rules/engine');
const { cleanBrand } = require('../src/rules/buckets');
const T = require('../src/rules/templates');

const HEAD = ['Credate', 'Userid', 'User Name', 'Cont Group', 'Code', 'Desc', 'Time', 'MKmagic', 'Custname', 'Company Name', 'Mobile', 'Strength', 'Description',
  'Orign', 'Orign Desc', 'Notes1', 'Notes2', 'Notes3', 'Email', 'FOC', 'Desc', 'FollDate', 'Time', 'Contdate', 'Locn', 'ContSeq', 'Orig', 'Follexec', 'Vehmodel', 'Source'];
const row = (date, user, code, desc, cust, company, mobile, strength, n1, n2, n3, model) =>
  [date, 'nsl00001', user, 'NF', code, desc, '00.00', '400001', cust, company, mobile, strength, strength > 4 ? 'Medium to High' : 'Weak',
    'N', '', n1, n2, n3, 'x@example.test', 'N58', 'NIS - Contact later', ' / /', '00.00', date, 'N01', '4030001', '4020001', 'nsl00001', model, 'N'];
const ROWS = [
  row('01/09/2026', 'Test Salesman', 'N58', 'Lapsed-Lost', 'Mr. Test Alpha', '', '39990101', 3, 'change his mind', '', '', 'N/Y63'),
  row('02/09/2026', 'Test Salesman', 'N42', 'Lapsed-Lost', 'Mrs. Test Beta', 'Test Co', '39990102', 4, 'She change her mind to Haval H6', '', '', 'N/'),
  row('02/09/2026', 'Test Salesman', 'N43', 'Lapsed-Follow Up', 'Mr. Test Gamma', '', '39990103', 6, 'He is not sure', 'back again in future if needed', '', 'N/'),
  row('02/09/2026', 'Test Salesman', 'N43', 'Lapsed-Lost', 'Ms. Test Delta', '', '39990104', 4, 'She need to', 'auto loan', '', 'N/'),
  row('02/09/2026', 'Test Salesman', 'N42', 'Lapsed-Lost', 'Mr. Test Epsilon', '', '39990105', 4, 'His wife change her mind to Cheery Tiggo 9.', '', '', 'N/A37')
];
function sheet() {
  const ws = XLSX.utils.aoa_to_sheet([HEAD, ...ROWS]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return readSpreadsheet(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'lost-leads.xlsx');
}

test('the columns of this export are recognised, with the note joined from Notes1..Notes3', () => {
  const s = sheet();
  assert.equal(s.headerless, false);
  const map = detect(s.names);
  assert.equal(map.mobile, 'Mobile');
  assert.equal(map.name, 'Custname', 'the customer, not the user who logged the lead');
  assert.equal(map.sales, 'User Name');
  assert.equal(map.reason, 'Notes1 + Notes2 + Notes3');
  assert.equal(map.comments, undefined, 'the Strength description is not a comment');
  assert.equal(map.status, 'Desc');
  assert.equal(map.date, 'Credate');
  assert.equal(map.model, 'Vehmodel');
  assert.equal(map.brand, undefined, '"Company Name" is the customer\'s employer, not the car brand');
});

test('the engine reads it: buckets from the notes, "Lapsed" is lost (not an open deal), first names from Custname', () => {
  const s = sheet();
  const o = runEngine(s.rows, detect(s.names), { holdPct: 0, seed: 2026, now: Date.parse('2026-11-23'), start: '2026-11-24', consentFrom: '2026-08-01' });
  assert.equal(o.excluded.length, 0, o.excluded.map(l => l.exReason).join(','));
  const by = Object.fromEntries(o.send.map(l => [l.mobile, l]));
  assert.equal(by['+97339990101'].bucket, 'noreason', '"change his mind" alone gives no reason: they get the ask-reason message');
  assert.equal(by['+97339990102'].bucket, 'competitor', 'Haval');
  assert.equal(by['+97339990103'].bucket, 'thinking', 'note continues in Notes2: "back again in future"');
  assert.equal(by['+97339990104'].bucket, 'price', '"auto loan" is in Notes2');
  assert.equal(by['+97339990105'].bucket, 'competitor', 'Tiggo (spelt Cheery) is a competitor model');
  assert.equal(by['+97339990101'].reason, 'change his mind');
  assert.equal(by['+97339990103'].reason, 'He is not sure back again in future if needed');
  assert.equal(by['+97339990101'].sales, 'Test Salesman');
  assert.equal(by['+97339990101'].model, 'Y63');
  assert.equal(by['+97339990102'].model, '');
  assert.deepEqual(by['+97339990101'].vars, ['Test', 'Y63', 'Y.K. Almoayyed'], 'ask-reason template: name, model, brand; no brand column gives the company name, never a code');
});

test('a default brand can be set for files without a brand column', () => {
  const s = sheet();
  const o = runEngine(s.rows, detect(s.names), { holdPct: 0, seed: 2026, now: Date.parse('2026-11-23'), start: '2026-11-24', consentFrom: '2026-08-01', defaultBrand: 'Haval Bahrain' });
  assert.equal(o.send[0].brand, 'Haval Bahrain');
  assert.match(o.send[0].message, /Haval Bahrain/);
});

test('an unknown brand code never reaches a customer message', () => {
  assert.equal(cleanBrand('N58'), '');
  assert.equal(cleanBrand('K48'), 'SOUEAST');
  assert.equal(cleanBrand('ZEEKR'), 'ZEEKR');
  assert.equal(T.fill('{brand}', { brand: cleanBrand('N58') }), 'Y.K. Almoayyed');
});
