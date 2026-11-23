'use strict';
// Decides who is due and queues their next template. Runs on a timer; with a
// fake clock in tests. Sends happen only on Bahrain working days, after the
// configured send time and outside quiet hours; the sender re-checks every gate.
const Q = require('../rules/sequence');
const T = require('../rules/templates');
const C = require('../clock');
const Settings = require('../settings');
const Opt = require('./optouts');
const Templates = require('./templates');
const Sender = require('./sender');
const { stateOf, saveState, dateLabelFor } = require('./conversation');
const { tx } = require('../db');

function templatesQueuedToday(ctx, now) {
  const [a, b] = C.bahrainDayRange(now);
  return ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE dir='out' AND kind='template' AND automated = 1 AND status NOT IN ('blocked','cancelled') AND created_at >= ? AND created_at < ?").get(a, b).n;
}

/** @returns {{enqueued:number, skipped?:string}} */
function tick(ctx) {
  const s = Settings.all(ctx.db), now = ctx.clock.now();
  // nothing advances while sending is stopped, or steps would pile up and go out back-to-back on release
  if (s.kill_switch) return { enqueued: 0, skipped: 'kill switch' };
  if (Sender.halted(ctx)) return { enqueued: 0, skipped: 'sending halted' };
  if (s.friday_skip && C.isFriday(now)) return { enqueued: 0, skipped: 'Friday' };
  if (C.inQuietHours(now, { start: s.quiet_start, end: s.quiet_end })) return { enqueued: 0, skipped: 'quiet hours' };
  const p = C.bahrainParts(now);
  if (p.hour * 60 + p.minute < C.toMin(s.send_time)) return { enqueued: 0, skipped: 'before the send time' };
  let capLeft = s.daily_cap - templatesQueuedToday(ctx, now);
  let enqueued = 0;
  const camps = ctx.db.prepare("SELECT * FROM campaigns WHERE status = 'running' ORDER BY id").all();
  for (const c of camps) {
    const day = C.dayIndex(c.start_date, now);
    if (day < 0) continue;
    const due = ctx.db.prepare("SELECT * FROM enrollments WHERE campaign_id = ? AND grp = 'send' AND status IN ('queued','active') AND next_day IS NOT NULL AND next_day <= ? ORDER BY id").all(c.id, day);
    for (const e of due) {
      if (capLeft <= 0) return { enqueued, skipped: 'daily cap reached' };
      tx(ctx.db, () => {
        if (Opt.isOptedOut(ctx.db, e.mobile)) { saveState(ctx, e.id, { ...stateOf(e), status: 'optout', next: null }); return; }
        if (Opt.suppressedOn(ctx.db, e.mobile)) { saveState(ctx, e.id, { ...Q.onListed(stateOf(e)), brief: 'Stopped: on the ' + Opt.LISTS[Opt.suppressedOn(ctx.db, e.mobile)] }); return; }
        if (!s.go_live && !Opt.isAllowed(ctx.db, e.mobile)) return;               // waits for go-live
        const tpl = T.templateForKey(e.next_key);
        if (!tpl || !Templates.approval(ctx.db, tpl.name, c.language || s.template_language).ok) return; // waits for approval
        const cust = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(e.customer_id);
        const body = tpl.body.en;
        const id = Sender.enqueueTemplate(ctx, { mobile: e.mobile, customerId: e.customer_id, enrollmentId: e.id, key: e.next_key, tplName: tpl.name,
          language: c.language || s.template_language, vars: T.varValues(body, cust), body: T.fill(body, cust), idemKey: `enr:${e.id}:t${e.tpl_count + 1}:${e.next_key}:d${e.next_day}` });
        if (!id) return; // already queued for this step and day: never advance without a message
        const r = Q.afterTemplate(stateOf(e), e.next_key, day, { dateLabel: dateLabelFor(c.start_date) });
        saveState(ctx, e.id, r.state);
        enqueued++; capLeft--;
      });
    }
  }
  return { enqueued };
}

/** Why customers in a running campaign are not moving (for the campaign screen). */
function waiting(ctx, campaignId) {
  const s = Settings.all(ctx.db);
  const c = ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const out = { test_mode: 0, template: 0, templates: [] };
  if (!c) return out;
  const day = Math.max(0, C.dayIndex(c.start_date, ctx.clock.now()));
  const due = ctx.db.prepare("SELECT mobile, next_key FROM enrollments WHERE campaign_id = ? AND grp = 'send' AND status IN ('queued','active') AND next_day IS NOT NULL AND next_day <= ?").all(c.id, day);
  const missing = new Set();
  for (const e of due) {
    if (!s.go_live && !Opt.isAllowed(ctx.db, e.mobile)) { out.test_mode++; continue; }
    const tpl = T.templateForKey(e.next_key);
    if (!tpl || !Templates.approval(ctx.db, tpl.name, c.language || s.template_language).ok) { out.template++; if (tpl) missing.add(tpl.name); }
  }
  out.templates = [...missing];
  return out;
}

module.exports = { tick, waiting };
