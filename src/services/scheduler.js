'use strict';
// Decides who is due and queues their next template. Runs on a timer (server) or
// during requests (Vercel); with a fake clock in tests. Sends happen only on Bahrain
// working days, after the configured send time and outside quiet hours; the sender
// re-checks every gate at the moment of sending.
const Q = require('../rules/sequence');
const T = require('../rules/templates');
const C = require('../clock');
const Settings = require('../settings');
const Opt = require('./optouts');
const Templates = require('./templates');
const Sender = require('./sender');
const { stateOf, saveState, dateLabelFor } = require('./conversation');

async function templatesQueuedToday(ctx, now) {
  const [a, b] = C.bahrainDayRange(now);
  return (await ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE dir='out' AND kind='template' AND automated = 1 AND status NOT IN ('blocked','cancelled') AND created_at >= ? AND created_at < ?").get(a, b)).n;
}
const setOf = async (ctx, sql, ...a) => new Set((await ctx.db.prepare(sql).all(...a)).map(r => r.mobile));

/** @returns {{enqueued:number, skipped?:string, more?:boolean}} */
async function tick(ctx, { deadline = Infinity } = {}) {
  const s = await Settings.all(ctx.db), now = ctx.clock.now();
  // nothing advances while sending is stopped, or steps would pile up and go out back-to-back on release
  if (s.kill_switch) return { enqueued: 0, skipped: 'kill switch' };
  if (await Sender.halted(ctx)) return { enqueued: 0, skipped: 'sending halted' };
  if (s.friday_skip && C.isFriday(now)) return { enqueued: 0, skipped: 'Friday' };
  if (C.inQuietHours(now, { start: s.quiet_start, end: s.quiet_end })) return { enqueued: 0, skipped: 'quiet hours' };
  const p = C.bahrainParts(now);
  if (p.hour * 60 + p.minute < C.toMin(s.send_time)) return { enqueued: 0, skipped: 'before the send time' };
  let capLeft = s.daily_cap - await templatesQueuedToday(ctx, now);
  let enqueued = 0;
  const camps = await ctx.db.prepare("SELECT * FROM campaigns WHERE status = 'running' ORDER BY id").all();
  const approved = new Map();   // template approvals, looked up once per run
  const isApproved = async (name, lang) => { const k = name + '|' + lang; if (!approved.has(k)) approved.set(k, (await Templates.approval(ctx.db, name, lang)).ok); return approved.get(k); };
  for (const c of camps) {
    const day = C.dayIndex(c.start_date, now);
    if (day < 0) continue;
    const dueSql = "FROM enrollments e WHERE e.campaign_id = ? AND e.grp = 'send' AND e.status IN ('queued','active') AND e.next_day IS NOT NULL AND e.next_day <= ?";
    const due = await ctx.db.prepare(`SELECT e.*, cu.name c_name, cu.brand c_brand, cu.model c_model ${dueSql.replace('FROM enrollments e', 'FROM enrollments e JOIN customers cu ON cu.id = e.customer_id')} ORDER BY e.id`).all(c.id, day);
    if (!due.length) continue;
    const optedOut = await setOf(ctx, `SELECT o.mobile FROM optouts o WHERE o.mobile IN (SELECT e.mobile ${dueSql})`, c.id, day);
    const listed = new Map((await ctx.db.prepare(`SELECT s.mobile, s.list FROM suppressions s WHERE s.mobile IN (SELECT e.mobile ${dueSql})`).all(c.id, day)).map(r => [r.mobile, r.list]));
    const allowed = s.go_live ? null : await setOf(ctx, 'SELECT mobile FROM allowlist');
    const lang = c.language || s.template_language;
    for (const e of due) {
      if (capLeft <= 0) return { enqueued, skipped: 'daily cap reached' };
      if (Date.now() > deadline) return { enqueued, more: true };
      if (optedOut.has(e.mobile)) { await saveState(ctx, e.id, { ...stateOf(e), status: 'optout', next: null }); continue; }
      if (listed.has(e.mobile)) { await saveState(ctx, e.id, { ...Q.onListed(stateOf(e)), brief: 'Stopped: on the ' + Opt.LISTS[listed.get(e.mobile)] }); continue; }
      if (allowed && !allowed.has(e.mobile)) continue;                          // waits for go-live
      const tpl = T.templateForKey(e.next_key);
      if (!tpl || !(await isApproved(tpl.name, lang))) continue;               // waits for approval
      const cust = { name: e.c_name, brand: e.c_brand, model: e.c_model };
      const idemKey = `enr:${e.id}:t${e.tpl_count + 1}:${e.next_key}:d${e.next_day}`;
      const id = await Sender.enqueueTemplate(ctx, { mobile: e.mobile, customerId: e.customer_id, enrollmentId: e.id, key: e.next_key, tplName: tpl.name,
        language: lang, vars: T.varValues(tpl.body.en, cust), body: T.fill(tpl.body.en, cust), idemKey });
      if (!id) {
        // the message exists already (a previous run stopped before saving the step): advance only if it is live
        const prev = await ctx.db.prepare('SELECT status FROM messages WHERE idem_key = ?').get(idemKey);
        if (!prev || ['blocked', 'cancelled'].includes(prev.status)) continue;
      }
      const r = Q.afterTemplate(stateOf(e), e.next_key, day, { dateLabel: dateLabelFor(c.start_date) });
      await saveState(ctx, e.id, r.state);
      if (id) { enqueued++; capLeft--; }
    }
  }
  return { enqueued };
}

/** Why customers in a running campaign are not moving (for the campaign screen). */
async function waiting(ctx, campaignId) {
  const s = await Settings.all(ctx.db);
  const c = await ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const out = { test_mode: 0, template: 0, templates: [] };
  if (!c) return out;
  const day = Math.max(0, C.dayIndex(c.start_date, ctx.clock.now()));
  const due = await ctx.db.prepare("SELECT mobile, next_key FROM enrollments WHERE campaign_id = ? AND grp = 'send' AND status IN ('queued','active') AND next_day IS NOT NULL AND next_day <= ?").all(c.id, day);
  const allowed = s.go_live ? null : await setOf(ctx, 'SELECT mobile FROM allowlist');
  const approved = new Map(), missing = new Set();
  for (const e of due) {
    if (allowed && !allowed.has(e.mobile)) { out.test_mode++; continue; }
    const tpl = T.templateForKey(e.next_key);
    const lang = c.language || s.template_language;
    if (tpl && !approved.has(tpl.name)) approved.set(tpl.name, (await Templates.approval(ctx.db, tpl.name, lang)).ok);
    if (!tpl || !approved.get(tpl.name)) { out.template++; if (tpl) missing.add(tpl.name); }
  }
  out.templates = [...missing];
  return out;
}

module.exports = { tick, waiting };
