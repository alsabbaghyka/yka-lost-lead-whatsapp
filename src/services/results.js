'use strict';
// Send vs holdout, the engine's honest way: two rates, the difference, a 95%
// interval, a two-proportion z test and the smallest difference these group
// sizes could prove. The Meta audience is in neither arm.
const crypto = require('node:crypto');
const { mobileOf, parseDate } = require('../rules/mobile');
const S = require('../rules/stats');
const { must } = require('../auth');
const { audit } = require('../audit');
const { tx } = require('../db');
const { notFound } = require('./errors');

const DATE_HDR = /date|invoice|service|visit|drive|delivery|created|job/i;

/** Port of loadOutcome: every mobile in the file, with the earliest date on its row. */
async function importOutcomes(ctx, { fileName, rows, user }) {
  must(user, 'results.edit');
  const headers = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const dateKeys = headers.filter(h => DATE_HDR.test(String(h)));
  const found = new Map();
  rows.forEach(r => {
    let when = null;
    dateKeys.forEach(k => { const d = parseDate(r[k]); if (d && (!when || d < when)) when = d; });
    if (!when) Object.values(r).forEach(v => { if (v instanceof Date && !isNaN(v) && (!when || v < when)) when = v; });
    Object.values(r).forEach(v => {
      const m = mobileOf(v); if (!m) return;
      const prev = found.get(m);
      if (prev === undefined || (when && (!prev || when < prev))) found.set(m, when || null);
    });
  });
  const batch = crypto.randomUUID();
  await tx(ctx.db, async () => {
    const rowsOut = [...found].map(([m, when]) => [m, when ? when.toISOString() : null, String(fileName || 'upload').slice(0, 200), batch, user.id, ctx.nowIso()]);
    for (let i = 0; i < rowsOut.length; i += 100) {
      const part = rowsOut.slice(i, i + 100);
      await ctx.db.prepare('INSERT OR IGNORE INTO outcome_events(mobile, at, source_file, batch_id, added_by, added_at) VALUES ' + part.map(() => '(?,?,?,?,?,?)').join(',')).run(...part.flat());
    }
  });
  await audit(ctx.db, user, 'outcomes.import', fileName, { mobiles: found.size, rows: rows.length });
  return { batch, mobiles: found.size, rows: rows.length, dateColumns: dateKeys };
}
const listOutcomeFiles = db => db.prepare('SELECT source_file, batch_id, MIN(added_at) added_at, COUNT(*) mobiles FROM outcome_events GROUP BY batch_id ORDER BY added_at DESC').all();
async function clearOutcomes(ctx, batchId, user) {
  must(user, 'results.edit');
  const n = (await ctx.db.prepare('DELETE FROM outcome_events WHERE batch_id = ?').run(batchId)).changes;
  await audit(ctx.db, user, 'outcomes.clear', batchId, { removed: n });
  return n;
}

async function outcomeMap(db) {
  const m = new Map();
  for (const r of await db.prepare('SELECT mobile, at FROM outcome_events').all()) {
    const when = r.at ? new Date(r.at) : null, prev = m.get(r.mobile);
    if (prev === undefined || (when && (!prev || when < prev))) m.set(r.mobile, when);
  }
  return m;
}

const pct = x => (x * 100).toFixed(1) + '%';
const pp = x => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + ' pts';

async function compute(ctx, campaignId, { windowDays = 60 } = {}) {
  const c = await ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!c) throw notFound('No such campaign');
  windowDays = Math.max(1, Math.min(365, Math.floor(+windowDays || 60)));
  const day0 = new Date(c.start_date + 'T00:00:00Z');
  const send = new Map(), hold = new Map();
  (await ctx.db.prepare("SELECT mobile FROM enrollments WHERE campaign_id = ? AND grp = 'send'").all(c.id)).forEach(r => send.set(r.mobile, { day0 }));
  (await ctx.db.prepare("SELECT mobile FROM enrollments WHERE campaign_id = ? AND grp = 'holdout'").all(c.id)).forEach(r => hold.set(r.mobile, { day0 }));
  (await ctx.db.prepare("SELECT mobile FROM import_leads WHERE import_id = ? AND grp = 'meta_holdout' AND mobile IS NOT NULL").all(c.import_id)).forEach(r => hold.set(r.mobile, { day0 }));
  const outcome = await outcomeMap(ctx.db);
  const a = S.scoreArm(send, outcome, windowDays), b = S.scoreArm(hold, outcome, windowDays);
  const base = { campaign: { id: c.id, name: c.name, start_date: c.start_date }, windowDays, messaged: a, holdout: b, outcomeMobiles: outcome.size };
  if (!a.n || !b.n || !outcome.size) return { ...base, ready: false, message: 'Add at least one outcome file (invoices, test drives, service jobs) with mobile numbers.' };
  const r = S.compareArms(a, b);
  const mde = S.minDetectable(a.n, b.n, b.rate);
  const sig = r.p < 0.05;
  const headline = !sig
    ? `Not proven either way. Messaged ${pct(r.p1)} against holdout ${pct(r.p2)} is ${pp(r.diff)}, and a gap that size turns up by chance often enough here (p = ${r.p.toFixed(3)}). That is not evidence the messages worked, and not evidence they failed.`
    : r.diff > 0 ? `The messaged group came back more often. ${pct(r.p1)} against ${pct(r.p2)}, a difference of ${pp(r.diff)} (p = ${r.p.toFixed(3)}).`
      : `The messaged group came back less often. ${pct(r.p1)} against ${pct(r.p2)}, a difference of ${pp(r.diff)} (p = ${r.p.toFixed(3)}). Worth checking the lists before acting on it.`;
  let overlap = 0; send.forEach((_, m) => { if (hold.has(m)) overlap++; });
  let matched = 0; outcome.forEach((_, m) => { if (send.has(m) || hold.has(m)) matched++; });
  const notes = [], note = (text, warn) => notes.push({ text, warn: !!warn });
  if (mde !== null) note(`These group sizes can only prove a difference of about ${pp(mde).replace('+', '')} or more. A real effect smaller than that will not show up here no matter how the numbers land — pool several months or brands before judging.`, r.diff < mde && !sig);
  if (b.n < 100) note(`The holdout is only ${b.n} customers. That is a small control group; treat this as a direction, not a result.`, true);
  if (a.undated + b.undated) note(`${a.undated + b.undated} of the matches had no usable date on one side, so they were counted without checking the ${windowDays}-day window.`);
  if (overlap) note(`${overlap} mobiles are in both groups, which biases the comparison.`, true);
  note(`${matched} of the ${outcome.size} mobiles in the outcome files belong to this campaign; the rest are other customers and are ignored.`);
  note('A match means the same mobile appeared, not that the message caused it. The holdout is the control: the difference between the two rows is the part the campaign can claim.');
  return { ...base, ready: true, compare: r, mde, matched, overlap, notes,
    verdict: { significant: sig, direction: !sig ? 'flat' : r.diff > 0 ? 'up' : 'down', headline, interval: `95% confidence interval on the difference: ${pp(r.lo)} to ${pp(r.hi)}.` } };
}

module.exports = { importOutcomes, listOutcomeFiles, clearOutcomes, compute };
