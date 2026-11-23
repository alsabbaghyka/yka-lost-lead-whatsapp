'use strict';
// The outbox. Every message to a customer is a row in `messages` first; this
// worker is the only code that hands one to the provider, and every safety rule
// is checked here, at the last moment, whatever queued it:
//   opt-out, holdout, paused/cancelled campaign, test-mode allow-list,
//   do-not-contact lists, template approval, 24-hour window,
//   kill switch, account halt, Friday, quiet hours, daily cap, per-second throttle.
// A message is claimed (queued -> sending, checked atomically) before it is handed
// over, so two processes — two Vercel instances — can never send the same row twice.
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
const STUCK_SENDING_MS = 5 * 60e3;

const customerId = async (ctx, mobile) => ((await ctx.db.prepare('SELECT id FROM customers WHERE mobile = ?').get(mobile)) || {}).id || null;

async function enqueueTemplate(ctx, { mobile, customerId: cid = null, enrollmentId = null, key, tplName, language, vars = [], body = null, idemKey, automated = true }) {
  const now = ctx.nowIso();
  const cust = cid || await customerId(ctx, mobile);
  const lang = language || await Settings.get(ctx.db, 'template_language');
  const r = await ctx.db.prepare(`INSERT OR IGNORE INTO messages(enrollment_id, customer_id, mobile, dir, kind, tpl_name, tpl_key, language, vars, body, status, idem_key, automated, created_at, updated_at)
    VALUES (?,?,?,'out','template',?,?,?,?,?,'queued',?,?,?,?)`).run(enrollmentId, cust, mobile, tplName, key || null, lang, JSON.stringify(vars), body, idemKey, automated ? 1 : 0, now, now);
  return r.changes ? r.lastInsertRowid : null;
}
/** Free text: a person's reply (user) or an automatic answer to the customer (automated). */
async function enqueueText(ctx, { mobile, enrollmentId = null, body, user = null, automated = !user, key = null }) {
  const now = ctx.nowIso();
  const cust = await customerId(ctx, mobile);
  const r = await ctx.db.prepare(`INSERT INTO messages(enrollment_id, customer_id, mobile, dir, kind, tpl_key, body, status, sent_by, automated, created_at, updated_at)
    VALUES (?,?,?,'out','text',?,?,'queued',?,?,?,?)`).run(enrollmentId, cust, mobile, key, String(body).slice(0, 4096), user ? user.id : null, automated ? 1 : 0, now, now);
  return r.lastInsertRowid;
}

/* ---------- halt after an account-level error ---------- */
async function halted(ctx) { const r = await ctx.db.prepare("SELECT value FROM system_state WHERE key = 'halted'").get(); return r ? JSON.parse(r.value) : null; }
async function halt(ctx, error) {
  await ctx.db.prepare("INSERT OR REPLACE INTO system_state(key, value, updated_at) VALUES ('halted', ?, ?)").run(JSON.stringify({ at: ctx.nowIso(), code: error.code, label: error.label }), ctx.nowIso());
  await audit(ctx.db, null, 'sending.halted', String(error.code || error.http || ''), { label: error.label });
  log('SENDING HALTED', error.label);
}
async function resume(ctx, user) {
  must(user, 'deadletter.retry');
  await ctx.db.prepare("DELETE FROM system_state WHERE key = 'halted'").run();
  await audit(ctx.db, user, 'sending.resumed', null);
}

/* ---------- daily cap: templates Meta accepted today (Bahrain day) ---------- */
async function templatesSentToday(ctx, now) {
  const [a, b] = C.bahrainDayRange(now);
  return (await ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE dir='out' AND kind='template' AND sent_at >= ? AND sent_at < ?").get(a, b)).n;
}
async function windowOpen(ctx, mobile, now) {
  const c = await ctx.db.prepare('SELECT last_inbound_at FROM customers WHERE mobile = ?').get(mobile);
  return !!(c && c.last_inbound_at && now - Date.parse(c.last_inbound_at) < WINDOW_MS);
}

/** {act: 'send'|'hold'|'block'|'cancel', reason} */
async function gate(ctx, m, s, now, capLeft) {
  const isTpl = m.kind === 'template';
  if (await Opt.isOptedOut(ctx.db, m.mobile) && m.tpl_key !== 'optout_confirm') return { act: 'cancel', reason: 'Cancelled: the customer opted out' };
  if (m.enrollment_id) {
    const e = await ctx.db.prepare('SELECT e.grp, c.status cstatus FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = ?').get(m.enrollment_id);
    if (e && e.grp === 'holdout') return { act: 'block', reason: 'Blocked: holdout customers are never messaged' };
    if (e && e.cstatus === 'cancelled' && m.automated) return { act: 'cancel', reason: 'Cancelled: the campaign was cancelled' };
    if (e && e.cstatus === 'paused' && isTpl) return { act: 'hold', reason: 'campaign paused' };
  }
  if (!s.go_live && !(await Opt.isAllowed(ctx.db, m.mobile))) return { act: 'block', reason: 'Blocked: test mode is on and this number is not on the allow-list' };
  if (isTpl) {
    const list = await Opt.suppressedOn(ctx.db, m.mobile);
    if (list) return { act: 'block', reason: `Blocked: on the ${Opt.LISTS[list]}` };
    const a = await Templates.approval(ctx.db, m.tpl_name, m.language);
    if (!a.ok) return { act: 'block', reason: a.status === 'UNKNOWN' ? `Blocked: template ${m.tpl_name} (${m.language}) is unknown — not approved, or templates not synced` : `Blocked: template not approved by Meta (${a.status})` };
  } else if (!(await windowOpen(ctx, m.mobile, now))) {
    return { act: 'block', reason: 'Blocked: outside the 24-hour customer service window — the customer has not written in the last 24 hours, so only an approved template can be sent' };
  }
  if (isTpl && m.automated) {
    if (s.friday_skip && C.isFriday(now)) return { act: 'hold', reason: 'Friday' };
    if (C.inQuietHours(now, { start: s.quiet_start, end: s.quiet_end })) return { act: 'hold', reason: 'quiet hours' };
    if (capLeft <= 0) return { act: 'hold', reason: 'daily cap reached' };
  }
  return { act: 'send' };
}

/* column names come only from object literals in this file, never from input */
async function setMsg(ctx, id, fields) {
  const keys = Object.keys(fields);
  await ctx.db.prepare(`UPDATE messages SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), ctx.nowIso(), id);
}

/** A queued automated template that is blocked before it leaves never reached the customer:
    put the step back so the scheduler offers it again (and applies its own waits) instead of
    counting it towards "3 unanswered". Only when it is still the enrollment's latest step. */
async function undoStep(ctx, m) {
  if (m.kind !== 'template' || !m.automated || !m.enrollment_id) return;
  const e = await ctx.db.prepare('SELECT e.*, c.start_date FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = ?').get(m.enrollment_id);
  if (!e || e.last_tpl !== m.tpl_key || !['active', 'asked', 'quiet', 'queued'].includes(e.status)) return;
  const tplCount = Math.max(0, e.tpl_count - 1);
  const status = tplCount === 0 ? 'queued' : 'active';
  await ctx.db.prepare('UPDATE enrollments SET status = ?, tpl_count = ?, unanswered = MAX(0, unanswered - 1), next_key = ?, next_day = ?, updated_at = ? WHERE id = ?')
    .run(status, tplCount, m.tpl_key, Math.max(0, C.dayIndex(e.start_date, ctx.clock.now()) + 1), ctx.nowIso(), e.id);
}

/** What a permanent failure means for the customer (shared with status webhooks). */
async function applyFailureEffects(ctx, m, err) {
  if (err.optout) await require('./optouts').addOptout(ctx, m.mobile, { source: 'meta_131050', text: err.label });
  if (err.undeliverable && m.enrollment_id) {
    await ctx.db.prepare("UPDATE enrollments SET status = 'failed', next_key = NULL, next_day = NULL, brief = ?, updated_at = ? WHERE id = ? AND status NOT IN ('optout')")
      .run('Not delivered — ' + err.label, ctx.nowIso(), m.enrollment_id);
  }
}

async function processOutbox(ctx, { limit = 500, deadline = Infinity } = {}) {
  const res = { sent: 0, held: 0, blocked: 0, retried: 0, failed: 0, halted: false };
  if (await halted(ctx)) { res.halted = true; return res; }
  const s = await Settings.all(ctx.db);
  if (s.kill_switch) return res;
  const now = ctx.clock.now();
  const times = ctx._sendTimes || (ctx._sendTimes = []);
  while (times.length && now - times[0] >= 1000) times.shift();
  let tokens = s.max_per_second - times.length;
  let capLeft = s.daily_cap - await templatesSentToday(ctx, now);
  const rows = await ctx.db.prepare("SELECT * FROM messages WHERE dir = 'out' AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?").all(new Date(now).toISOString(), limit);
  for (const m of rows) {
    if (Date.now() > deadline) { res.more = true; break; }
    const g = await gate(ctx, m, s, now, capLeft);
    if (g.act === 'hold') { res.held++; continue; }
    if (g.act === 'block' || g.act === 'cancel') {
      await setMsg(ctx, m.id, { status: g.act === 'block' ? 'blocked' : 'cancelled', outcome: g.reason });
      if (g.act === 'block') await undoStep(ctx, m);
      res.blocked++; continue;
    }
    if (tokens <= 0) break;
    // claim it: only one process can move this row from queued to sending
    const claimed = (await ctx.db.prepare("UPDATE messages SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'").run(ctx.nowIso(), m.id)).changes === 1;
    if (!claimed) continue;
    tokens--; times.push(now);
    const r = m.kind === 'template'
      ? await ctx.provider.sendTemplate({ to: m.mobile, name: m.tpl_name, language: m.language, params: JSON.parse(m.vars || '[]') })
      : await ctx.provider.sendText({ to: m.mobile, body: m.body });
    if (r.ok) {
      await setMsg(ctx, m.id, { status: 'accepted', wamid: r.wamid, sent_at: new Date(now).toISOString(), attempts: m.attempts + 1, outcome: r.pacing ? 'Meta pacing: ' + r.pacing : null });
      await ctx.db.prepare('UPDATE customers SET last_outbound_at = ? WHERE mobile = ?').run(new Date(now).toISOString(), m.mobile);
      if (m.kind === 'template') capLeft--;
      res.sent++;
      continue;
    }
    const e = r.error;
    if (e.kind === 'account') {
      await setMsg(ctx, m.id, { status: 'queued', outcome: 'Waiting: ' + e.label });
      await halt(ctx, e); res.halted = true; break;
    }
    const attempts = m.attempts + 1;
    if (e.kind === 'retry' && attempts < s.max_attempts) {
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
      await setMsg(ctx, m.id, { status: 'queued', attempts, error_code: e.code, error_title: e.title, outcome: `Retrying: ${e.label}`, next_attempt_at: new Date(now + wait).toISOString() });
      res.retried++;
      continue;
    }
    await setMsg(ctx, m.id, { status: 'failed', attempts, error_code: e.code, error_title: e.title, outcome: e.label });
    res.failed++;
    if (e.kind === 'retry') {
      await ctx.db.prepare('INSERT INTO dead_letters(message_id, reason, created_at) VALUES (?,?,?)').run(m.id, `Gave up after ${attempts} attempts: ${e.label}`, ctx.nowIso());
      await audit(ctx.db, null, 'message.dead_letter', maskMobile(m.mobile), { message: m.id, code: e.code, label: e.label });
    } else await applyFailureEffects(ctx, m, e);
  }
  return res;
}

async function retryDeadLetter(ctx, id, user) {
  must(user, 'deadletter.retry');
  const dl = await ctx.db.prepare('SELECT * FROM dead_letters WHERE id = ? AND resolved_at IS NULL').get(id);
  if (!dl) throw notFound('No open dead letter with that id');
  await setMsg(ctx, dl.message_id, { status: 'queued', attempts: 0, next_attempt_at: null, outcome: 'Re-queued from dead letters' });
  await ctx.db.prepare("UPDATE dead_letters SET resolved_at = ?, resolved_by = ?, resolution = 'retried' WHERE id = ?").run(ctx.nowIso(), user.id, id);
  await audit(ctx.db, user, 'dead_letter.retry', String(id));
}
async function discardDeadLetter(ctx, id, user) {
  must(user, 'deadletter.retry');
  const n = (await ctx.db.prepare("UPDATE dead_letters SET resolved_at = ?, resolved_by = ?, resolution = 'discarded' WHERE id = ? AND resolved_at IS NULL").run(ctx.nowIso(), user.id, id)).changes;
  if (!n) throw notFound('No open dead letter with that id');
  await audit(ctx.db, user, 'dead_letter.discard', String(id));
}
const listDeadLetters = db => db.prepare(`SELECT d.*, m.mobile, m.kind, m.tpl_name, m.error_code, m.outcome FROM dead_letters d JOIN messages m ON m.id = d.message_id
  WHERE d.resolved_at IS NULL ORDER BY d.id DESC`).all();

/** A message left 'sending' for more than five minutes may or may not have reached Meta (the
    process died mid-call). Never resend blindly: dead-letter it for a person to check. The age
    limit matters on Vercel, where another instance may be sending right now. */
async function recoverInFlight(ctx) {
  const cutoff = new Date(ctx.clock.now() - STUCK_SENDING_MS).toISOString();
  const rows = await ctx.db.prepare("SELECT id FROM messages WHERE status = 'sending' AND updated_at < ?").all(cutoff);
  for (const r of rows) {
    const moved = (await ctx.db.prepare("UPDATE messages SET status = 'failed', outcome = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
      .run('Unknown: the server stopped while sending. Check the customer timeline before retrying from dead letters.', ctx.nowIso(), r.id)).changes;
    if (moved) await ctx.db.prepare('INSERT INTO dead_letters(message_id, reason, created_at) VALUES (?,?,?)').run(r.id, 'Interrupted mid-send; may or may not have been delivered', ctx.nowIso());
  }
  return rows.length;
}

module.exports = { enqueueTemplate, enqueueText, processOutbox, gate, halted, resume, applyFailureEffects, retryDeadLetter, discardDeadLetter, listDeadLetters, recoverInFlight, templatesSentToday, windowOpen };
