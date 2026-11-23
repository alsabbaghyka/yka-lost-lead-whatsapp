'use strict';
// The outbox. Every message to a customer is a row in `messages` first; this
// worker is the only code that hands one to the provider, and every safety rule
// is checked here, at the last moment, whatever queued it:
//   opt-out, holdout, paused/cancelled campaign, test-mode allow-list,
//   do-not-contact lists, template approval, 24-hour window,
//   kill switch, account halt, Friday, quiet hours, daily cap, per-second throttle.
const Settings = require('../settings');
const Opt = require('./optouts');
const Templates = require('./templates');
const C = require('../clock');
const { audit } = require('../audit');
const { must } = require('../auth');
const { log, maskMobile } = require('../mask');
const { notFound } = require('./errors');

const WINDOW_MS = 24 * 3600e3;
const BACKOFF_BASE_MS = 2000, BACKOFF_MAX_MS = 15 * 60e3;

function enqueueTemplate(ctx, { mobile, customerId = null, enrollmentId = null, key, tplName, language, vars = [], body = null, idemKey }) {
  const now = ctx.nowIso();
  const cust = customerId || (ctx.db.prepare('SELECT id FROM customers WHERE mobile = ?').get(mobile) || {}).id || null;
  const r = ctx.db.prepare(`INSERT OR IGNORE INTO messages(enrollment_id, customer_id, mobile, dir, kind, tpl_name, tpl_key, language, vars, body, status, idem_key, automated, created_at, updated_at)
    VALUES (?,?,?,'out','template',?,?,?,?,?,'queued',?,1,?,?)`).run(enrollmentId, cust, mobile, tplName, key || null, language || Settings.get(ctx.db, 'template_language'), JSON.stringify(vars), body, idemKey, now, now);
  return r.changes ? Number(r.lastInsertRowid) : null;
}
/** Free text: a person's reply (user) or an automatic answer to the customer (automated). */
function enqueueText(ctx, { mobile, enrollmentId = null, body, user = null, automated = !user, key = null }) {
  const now = ctx.nowIso();
  const cust = (ctx.db.prepare('SELECT id FROM customers WHERE mobile = ?').get(mobile) || {}).id || null;
  const r = ctx.db.prepare(`INSERT INTO messages(enrollment_id, customer_id, mobile, dir, kind, tpl_key, body, status, sent_by, automated, created_at, updated_at)
    VALUES (?,?,?,'out','text',?,?,'queued',?,?,?,?)`).run(enrollmentId, cust, mobile, key, String(body).slice(0, 4096), user ? user.id : null, automated ? 1 : 0, now, now);
  return Number(r.lastInsertRowid);
}

/* ---------- halt after an account-level error ---------- */
const halted = ctx => { const r = ctx.db.prepare("SELECT value FROM system_state WHERE key = 'halted'").get(); return r ? JSON.parse(r.value) : null; };
function halt(ctx, error) {
  ctx.db.prepare("INSERT OR REPLACE INTO system_state(key, value, updated_at) VALUES ('halted', ?, ?)").run(JSON.stringify({ at: ctx.nowIso(), code: error.code, label: error.label }), ctx.nowIso());
  audit(ctx.db, null, 'sending.halted', String(error.code || error.http || ''), { label: error.label });
  log('SENDING HALTED', error.label);
}
function resume(ctx, user) {
  must(user, 'deadletter.retry');
  ctx.db.prepare("DELETE FROM system_state WHERE key = 'halted'").run();
  audit(ctx.db, user, 'sending.resumed', null);
}

/* ---------- daily cap: templates Meta accepted today (Bahrain day) ---------- */
function dayBounds(now) { const d = C.bahrainDate(now); const s = C.bahrainInstant(d, '00:00'); return [new Date(s).toISOString(), new Date(s + 864e5).toISOString()]; }
function templatesSentToday(ctx, now) {
  const [a, b] = dayBounds(now);
  return ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE dir='out' AND kind='template' AND sent_at >= ? AND sent_at < ?").get(a, b).n;
}
const windowOpen = (ctx, mobile, now) => { const c = ctx.db.prepare('SELECT last_inbound_at FROM customers WHERE mobile = ?').get(mobile); return !!(c && c.last_inbound_at && now - Date.parse(c.last_inbound_at) < WINDOW_MS); };

/** {act: 'send'|'hold'|'block'|'cancel', reason} */
function gate(ctx, m, s, now, capLeft) {
  const isTpl = m.kind === 'template';
  if (Opt.isOptedOut(ctx.db, m.mobile) && m.tpl_key !== 'optout_confirm') return { act: 'cancel', reason: 'Cancelled: the customer opted out' };
  if (m.enrollment_id) {
    const e = ctx.db.prepare('SELECT e.grp, c.status cstatus FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = ?').get(m.enrollment_id);
    if (e && e.grp === 'holdout') return { act: 'block', reason: 'Blocked: holdout customers are never messaged' };
    if (e && e.cstatus === 'cancelled' && m.automated) return { act: 'cancel', reason: 'Cancelled: the campaign was cancelled' };
    if (e && e.cstatus === 'paused' && isTpl) return { act: 'hold', reason: 'campaign paused' };
  }
  if (!s.go_live && !Opt.isAllowed(ctx.db, m.mobile)) return { act: 'block', reason: 'Blocked: test mode is on and this number is not on the allow-list' };
  if (isTpl) {
    const list = Opt.suppressedOn(ctx.db, m.mobile);
    if (list) return { act: 'block', reason: `Blocked: on the ${Opt.LISTS[list]}` };
    const a = Templates.approval(ctx.db, m.tpl_name, m.language);
    if (!a.ok) return { act: 'block', reason: a.status === 'UNKNOWN' ? `Blocked: template ${m.tpl_name} (${m.language}) is unknown — not approved, or templates not synced` : `Blocked: template not approved by Meta (${a.status})` };
  } else if (!windowOpen(ctx, m.mobile, now)) {
    return { act: 'block', reason: 'Blocked: outside the 24-hour customer service window — the customer has not written in the last 24 hours, so only an approved template can be sent' };
  }
  if (isTpl && m.automated) {
    if (s.friday_skip && C.isFriday(now)) return { act: 'hold', reason: 'Friday' };
    if (C.inQuietHours(now, { start: s.quiet_start, end: s.quiet_end })) return { act: 'hold', reason: 'quiet hours' };
    if (capLeft <= 0) return { act: 'hold', reason: 'daily cap reached' };
  }
  return { act: 'send' };
}

function setMsg(ctx, id, fields) {
  const keys = Object.keys(fields);
  ctx.db.prepare(`UPDATE messages SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), ctx.nowIso(), id);
}

/** What a permanent failure means for the customer (shared with status webhooks). */
function applyFailureEffects(ctx, m, err) {
  if (err.optout) require('./optouts').addOptout(ctx, m.mobile, { source: 'meta_131050', text: err.label });
  if (err.undeliverable && m.enrollment_id) {
    ctx.db.prepare("UPDATE enrollments SET status = 'failed', next_key = NULL, next_day = NULL, brief = ?, updated_at = ? WHERE id = ? AND status NOT IN ('optout')")
      .run('Not delivered — ' + err.label, ctx.nowIso(), m.enrollment_id);
  }
}

async function processOutbox(ctx, { limit = 500 } = {}) {
  const res = { sent: 0, held: 0, blocked: 0, retried: 0, failed: 0, halted: false };
  if (halted(ctx)) { res.halted = true; return res; }
  const s = Settings.all(ctx.db);
  if (s.kill_switch) return res;
  const now = ctx.clock.now();
  const times = ctx._sendTimes || (ctx._sendTimes = []);
  while (times.length && now - times[0] >= 1000) times.shift();
  let tokens = s.max_per_second - times.length;
  let capLeft = s.daily_cap - templatesSentToday(ctx, now);
  const rows = ctx.db.prepare("SELECT * FROM messages WHERE dir = 'out' AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?").all(new Date(now).toISOString(), limit);
  for (const m of rows) {
    const g = gate(ctx, m, s, now, capLeft);
    if (g.act === 'hold') { res.held++; continue; }
    if (g.act === 'block' || g.act === 'cancel') { setMsg(ctx, m.id, { status: g.act === 'block' ? 'blocked' : 'cancelled', outcome: g.reason }); res.blocked++; continue; }
    if (tokens <= 0) break;
    tokens--; times.push(now);
    setMsg(ctx, m.id, { status: 'sending' });
    const r = m.kind === 'template'
      ? await ctx.provider.sendTemplate({ to: m.mobile, name: m.tpl_name, language: m.language, params: JSON.parse(m.vars || '[]') })
      : await ctx.provider.sendText({ to: m.mobile, body: m.body });
    if (r.ok) {
      setMsg(ctx, m.id, { status: 'accepted', wamid: r.wamid, sent_at: new Date(now).toISOString(), attempts: m.attempts + 1, outcome: r.pacing ? 'Meta pacing: ' + r.pacing : null });
      ctx.db.prepare('UPDATE customers SET last_outbound_at = ? WHERE mobile = ?').run(new Date(now).toISOString(), m.mobile);
      if (m.kind === 'template') capLeft--;
      res.sent++;
      continue;
    }
    const e = r.error;
    if (e.kind === 'account') {
      setMsg(ctx, m.id, { status: 'queued', outcome: 'Waiting: ' + e.label });
      halt(ctx, e); res.halted = true; break;
    }
    const attempts = m.attempts + 1;
    if (e.kind === 'retry' && attempts < s.max_attempts) {
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
      setMsg(ctx, m.id, { status: 'queued', attempts, error_code: e.code, error_title: e.title, outcome: `Retrying: ${e.label}`, next_attempt_at: new Date(now + wait).toISOString() });
      res.retried++;
      continue;
    }
    setMsg(ctx, m.id, { status: 'failed', attempts, error_code: e.code, error_title: e.title, outcome: e.label });
    res.failed++;
    if (e.kind === 'retry') {
      ctx.db.prepare('INSERT INTO dead_letters(message_id, reason, created_at) VALUES (?,?,?)').run(m.id, `Gave up after ${attempts} attempts: ${e.label}`, ctx.nowIso());
      audit(ctx.db, null, 'message.dead_letter', maskMobile(m.mobile), { message: m.id, code: e.code, label: e.label });
    } else applyFailureEffects(ctx, m, e);
  }
  return res;
}

function retryDeadLetter(ctx, id, user) {
  must(user, 'deadletter.retry');
  const dl = ctx.db.prepare('SELECT * FROM dead_letters WHERE id = ? AND resolved_at IS NULL').get(id);
  if (!dl) throw notFound('No open dead letter with that id');
  setMsg(ctx, dl.message_id, { status: 'queued', attempts: 0, next_attempt_at: null, outcome: 'Re-queued from dead letters' });
  ctx.db.prepare("UPDATE dead_letters SET resolved_at = ?, resolved_by = ?, resolution = 'retried' WHERE id = ?").run(ctx.nowIso(), user.id, id);
  audit(ctx.db, user, 'dead_letter.retry', String(id));
}
function discardDeadLetter(ctx, id, user) {
  must(user, 'deadletter.retry');
  const n = ctx.db.prepare("UPDATE dead_letters SET resolved_at = ?, resolved_by = ?, resolution = 'discarded' WHERE id = ? AND resolved_at IS NULL").run(ctx.nowIso(), user.id, id).changes;
  if (!n) throw notFound('No open dead letter with that id');
  audit(ctx.db, user, 'dead_letter.discard', String(id));
}
const listDeadLetters = db => db.prepare(`SELECT d.*, m.mobile, m.kind, m.tpl_name, m.error_code, m.outcome FROM dead_letters d JOIN messages m ON m.id = d.message_id
  WHERE d.resolved_at IS NULL ORDER BY d.id DESC`).all();

/** On start-up: a message left 'sending' may or may not have reached Meta. Never resend blindly. */
function recoverInFlight(ctx) {
  const rows = ctx.db.prepare("SELECT id FROM messages WHERE status = 'sending'").all();
  for (const r of rows) {
    setMsg(ctx, r.id, { status: 'failed', outcome: 'Unknown: the server stopped while sending. Check the customer timeline before retrying from dead letters.' });
    ctx.db.prepare('INSERT INTO dead_letters(message_id, reason, created_at) VALUES (?,?,?)').run(r.id, 'Interrupted mid-send; may or may not have been delivered', ctx.nowIso());
  }
  return rows.length;
}

module.exports = { enqueueTemplate, enqueueText, processOutbox, gate, halted, resume, applyFailureEffects, retryDeadLetter, discardDeadLetter, listDeadLetters, recoverInFlight, templatesSentToday, windowOpen };
