'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../vendor/xlsx.js');
const { readSpreadsheet } = require('../src/spreadsheet');
const { sampleRows } = require('../src/rules/engine');
const { makeSystem } = require('./helpers');
const Campaigns = require('../src/services/campaigns');
const Results = require('../src/services/results');
const Exports = require('../src/services/exports');
const Templates = require('../src/services/templates');
const { compareArms } = require('../src/rules/stats');

test('spreadsheet: xlsx with dates, and UTF-8 CSV with Arabic', async () => {
  const ws = XLSX.utils.json_to_sheet(sampleRows().slice(0, 3), { cellDates: true });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const r = readSpreadsheet(buf, 'lost.xlsx');
  assert.equal(r.rows.length, 3); assert.equal(r.headerless, false);
  assert.ok(r.rows[0]['Created Date'] instanceof Date);
  const csv = Buffer.from('﻿Mobile,Lost Reason,Reply\n39990001,السعر,توقف\n', 'utf8');
  const c = readSpreadsheet(csv, 'replies.csv');
  assert.equal(c.rows[0].Reply, 'توقف');
});
test('spreadsheet: a file with no header row is read by content', async () => {
  const csv = Buffer.from('39990001,K48,S/S07,Lost - price,12/10/2026\n39990002,K58,Z/7X,Lost - stock,13/10/2026\n');
  const r = readSpreadsheet(csv, 'x.csv');
  assert.equal(r.headerless, true);
  assert.match(r.names[0], /^Col A/);
});
test('spreadsheet: a huge declared range is shrunk to the real cells', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['Mobile', 'Lost Reason'], ['39990001', 'Price']]);
  ws['!ref'] = 'A1:C60000'; // as CRM exports do (kept small so the test writes fast)
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const r = readSpreadsheet(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'big.xlsx');
  assert.equal(r.rows.length, 1);
});

async function sampleCampaign() {
  const sys = (await makeSystem({ now: '2026-12-01T07:00:00Z' }));
  const { ctx, users } = sys;
  await Templates.sync(ctx, users.admin);
  const imp = (await Campaigns.createImport(ctx, { fileName: 'Sample data', rows: sampleRows(), user: users.m1 }));
  const c = (await Campaigns.createCampaign(ctx, { importId: imp.importId, name: 'Sample', startDate: '2026-12-02', user: users.m1 }));
  (await Campaigns.submit(ctx, c.id, users.m1)); (await Campaigns.approve(ctx, c.id, users.m2)); (await Campaigns.start(ctx, c.id, users.m1));
  return { ...sys, imp, campaignId: c.id };
}

test('results: arms are the send list and the holdout (incl. Meta holdout); Meta audience is in neither', async () => {
  const s = await sampleCampaign();
  const r0 = (await Results.compute(s.ctx, s.campaignId, { windowDays: 60 }));
  assert.equal(r0.messaged.n, 106);
  assert.equal(r0.holdout.n, 12);
  assert.equal(r0.ready, false, 'no outcome file yet');
  const send = (await s.db.prepare("SELECT mobile FROM enrollments WHERE grp='send' ORDER BY id").all()).map(r => r.mobile);
  const hold = (await s.db.prepare("SELECT mobile FROM import_leads WHERE grp IN ('holdout','meta_holdout') ORDER BY id").all()).map(r => r.mobile);
  const meta = (await s.db.prepare("SELECT mobile FROM import_leads WHERE grp='meta'").all()).map(r => r.mobile);
  // 20 of the messaged and 1 of the holdout came back; one messaged too late; one undated; a Meta-audience buyer is ignored
  const rows = [];
  send.slice(0, 20).forEach(m => rows.push({ Mobile: m.slice(4), 'Invoice Date': '15/12/2026' }));
  rows.push({ Mobile: send[20].slice(4), 'Invoice Date': '15/06/2027' });
  rows.push({ Mobile: send[21].slice(4), 'Invoice Date': '' });
  rows.push({ Mobile: hold[0].slice(4), 'Invoice Date': '20/12/2026' });
  rows.push({ Mobile: meta[0].slice(4), 'Invoice Date': '20/12/2026' });
  rows.push({ Mobile: '39998888', 'Invoice Date': '20/12/2026' });
  const imp = (await Results.importOutcomes(s.ctx, { fileName: 'invoices.xlsx', rows, user: s.users.m1 }));
  assert.equal(imp.mobiles, 25);
  const r = (await Results.compute(s.ctx, s.campaignId, { windowDays: 60 }));
  assert.equal(r.ready, true);
  assert.deepEqual([r.messaged.n, r.messaged.conv, r.messaged.undated], [106, 21, 1]);
  assert.deepEqual([r.holdout.n, r.holdout.conv], [12, 1]);
  const want = compareArms({ n: 106, conv: 21 }, { n: 12, conv: 1 });
  assert.equal(r.compare.diff, want.diff); assert.equal(r.compare.p, want.p);
  assert.equal(r.verdict.significant, false);
  assert.match(r.verdict.headline, /Not proven either way/);
  assert.ok(r.notes.some(n => /only 12 customers/.test(n.text)));
  assert.equal(r.matched, 23, '22 messaged (incl. the late one) + 1 holdout; the Meta buyer and the stranger are in neither arm');
});
test('exports: CRM write-back and send list are CSV with the engine columns', async () => {
  const s = await sampleCampaign();
  const crm = (await Exports.crmWriteback(s.ctx, s.campaignId));
  const lines = crm.split('\r\n');
  assert.match(lines[0], /^mobile,first_name,brand,model,campaign,group,status,outcome,last_message_at,salesperson,handed_over_at,resolved_at,opted_out$/);
  assert.equal(lines.length, 1 + (await s.db.prepare('SELECT COUNT(*) n FROM enrollments').get()).n, 'every enrolled customer');
  const send = (await Exports.importCsv(s.ctx, s.imp.importId, 'send'));
  assert.match(send.split('\r\n')[0], /^mobile,first_name,brand,model,bucket,track,template_name,var1,var2,var3,day0,day2,day7,day30/);
  assert.equal(send.split('\r\n').length, 107);
  assert.equal(Exports.csv([['a', 'x,"y"'], ['=cmd', '+SUM(1)', '+97339991000']]), 'a,"x,""y"""\r\n\'=cmd,\'+SUM(1),+97339991000', 'formula injection is neutralised, mobiles kept');
});
