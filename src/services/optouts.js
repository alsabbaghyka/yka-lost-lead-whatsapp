'use strict';
// Opt-outs (permanent, global, honoured instantly), the do-not-contact and
// recent-buyer lists, and the test-mode allow-list.
const { cleanMobile, mobileOf } = require('../rules/mobile');
const { parseOptoutRows } = require('../rules/replies');
const { must } = require('../auth');
const { audit } = require('../audit');
const { tx } = require('../db');
const { bad } = require('./errors');

const need = m => { const c = cleanMobile(m); if (!c) throw bad('Not a Bahrain mobile: use 8 digits starting 3 or 6'); return c; };
const isOptedOut = async (db, mobile) => !!(await db.prepare('SELECT 1 FROM optouts WHERE mobile = ?').get(mobile));

/** Add an opt-out and stop everything for that number at once. user null = the system (a STOP reply). */
async function addOptout(ctx, mobile, { source = 'manual', text = null, user = null } = {}) {
  if (user) must(user, 'optout.add');
  const m = need(mobile), now = ctx.nowIso();
  return tx(ctx.db, async () => {
    const added = (await ctx.db.prepare('INSERT OR IGNORE INTO optouts(mobile, at, source, text) VALUES (?,?,?,?)').run(m, now, source, text ? String(text).slice(0, 500) : null)).changes > 0;
    const enr = (await ctx.db.prepare("UPDATE enrollments SET status = 'optout', next_key = NULL, next_day = NULL, updated_at = ?, brief = COALESCE(brief, 'Opted out') WHERE mobile = ? AND status NOT IN ('optout')").run(now, m)).changes;
    const cancelled = (await ctx.db.prepare("UPDATE messages SET status = 'cancelled', outcome = 'Cancelled: the customer opted out', updated_at = ? WHERE mobile = ? AND dir = 'out' AND status = 'queued' AND COALESCE(tpl_key, '') <> 'optout_confirm'").run(now, m)).changes;
    if (added) await audit(ctx.db, user, 'optout.add', m, { source, enrollments: enr, cancelled }, now);
    return { added, enrollments: enr, cancelled };
  });
}
const listOptouts = db => db.prepare('SELECT mobile, at, source FROM optouts ORDER BY at DESC').all();

/** A replies export or a plain list of numbers (see rules/replies.parseOptoutRows). */
async function importOptoutFile(ctx, { rows, headers, fileName, user }) {
  must(user, 'suppression.edit');
  const r = parseOptoutRows(rows, headers);
  let added = 0;
  for (const m of r.mobiles) if ((await addOptout(ctx, m, { source: 'import:' + String(fileName || '').slice(0, 80), user: null })).added) added++;
  await audit(ctx.db, user, 'optout.import', fileName, { found: r.mobiles.length, added, outbound: r.outbound, noText: r.noText });
  return { found: r.mobiles.length, added, outbound: r.outbound, noText: r.noText };
}

const LISTS = { dnc: 'do-not-contact list', recent_buyer: 'recent buyers list' };
async function addSuppressions(ctx, list, mobiles, user, source = 'manual') {
  must(user, 'suppression.edit');
  if (!LISTS[list]) throw bad('List must be dnc or recent_buyer');
  const now = ctx.nowIso(); let added = 0, invalid = 0;
  await tx(ctx.db, async () => {
    for (const v of mobiles) {
      const m = mobileOf(v) || cleanMobile(v);
      if (!m) { invalid++; continue; }
      added += (await ctx.db.prepare('INSERT OR IGNORE INTO suppressions(mobile, list, added_at, source, added_by) VALUES (?,?,?,?,?)').run(m, list, now, source, user.id)).changes;
    }
  });
  await audit(ctx.db, user, 'suppression.add', list, { added, invalid, source });
  return { added, invalid };
}
/** every mobile in every cell of an uploaded file (dates skipped) */
function suppressionsFromRows(ctx, list, rows, fileName, user) {
  const mobiles = new Set();
  rows.forEach(r => Object.values(r).forEach(v => { const m = mobileOf(v); if (m) mobiles.add(m); }));
  return addSuppressions(ctx, list, [...mobiles], user, 'file:' + String(fileName || '').slice(0, 80));
}
async function removeSuppression(ctx, list, mobile, user) {
  must(user, 'suppression.edit');
  const m = need(mobile);
  const n = (await ctx.db.prepare('DELETE FROM suppressions WHERE mobile = ? AND list = ?').run(m, list)).changes;
  await audit(ctx.db, user, 'suppression.remove', m, { list });
  return n;
}
const suppressedOn = async (db, mobile) => { const r = await db.prepare('SELECT list FROM suppressions WHERE mobile = ? ORDER BY list').get(mobile); return r ? r.list : null; };
const listSuppressions = (db, list) => db.prepare('SELECT mobile, list, added_at, source FROM suppressions WHERE (? IS NULL OR list = ?) ORDER BY added_at DESC').all(list || null, list || null);

async function allowlistAdd(ctx, mobile, note, user) {
  must(user, 'settings.edit');
  const m = need(mobile);
  await ctx.db.prepare('INSERT OR REPLACE INTO allowlist(mobile, note, added_at, added_by) VALUES (?,?,?,?)').run(m, note || null, ctx.nowIso(), user.id);
  await audit(ctx.db, user, 'allowlist.add', m, { note });
  return m;
}
async function allowlistRemove(ctx, mobile, user) {
  must(user, 'settings.edit');
  const m = need(mobile);
  await ctx.db.prepare('DELETE FROM allowlist WHERE mobile = ?').run(m);
  await audit(ctx.db, user, 'allowlist.remove', m);
}
const isAllowed = async (db, mobile) => !!(await db.prepare('SELECT 1 FROM allowlist WHERE mobile = ?').get(mobile));
const listAllowlist = db => db.prepare('SELECT mobile, note, added_at FROM allowlist ORDER BY added_at').all();

module.exports = { isOptedOut, addOptout, listOptouts, importOptoutFile, LISTS, addSuppressions, suppressionsFromRows, removeSuppression, suppressedOn, listSuppressions,
  allowlistAdd, allowlistRemove, isAllowed, listAllowlist };
