'use strict';
// Customer lookup, timeline and erasure. Erasure removes the history but never
// the opt-out (or a do-not-contact entry): forgetting someone must not make
// them messageable again.
const { cleanMobile } = require('../rules/mobile');
const { must } = require('../auth');
const { audit } = require('../audit');
const { tx } = require('../db');
const Opt = require('./optouts');
const { bad, notFound } = require('./errors');

function search(ctx, q, limit = 50) {
  const m = cleanMobile(q);
  if (m) return ctx.db.prepare('SELECT * FROM customers WHERE mobile = ?').all(m);
  const s = String(q || '').trim();
  if (s.length < 2) return [];
  return ctx.db.prepare("SELECT * FROM customers WHERE name LIKE ? ESCAPE '\\' OR mobile LIKE ? ORDER BY last_seen DESC LIMIT ?")
    .all('%' + s.replace(/[%_\\]/g, '\\$&') + '%', '%' + s.replace(/\D/g, '') + '%', limit);
}

function timeline(ctx, mobile) {
  const m = cleanMobile(mobile); if (!m) throw bad('Not a Bahrain mobile');
  const customer = ctx.db.prepare('SELECT * FROM customers WHERE mobile = ?').get(m) || null;
  const optout = ctx.db.prepare('SELECT * FROM optouts WHERE mobile = ?').get(m) || null;
  const suppressions = ctx.db.prepare('SELECT list, added_at, source FROM suppressions WHERE mobile = ?').all(m);
  if (!customer && !optout && !suppressions.length) throw notFound('No customer with that mobile');
  const enrollments = ctx.db.prepare('SELECT e.*, c.name campaign, c.start_date FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.mobile = ? ORDER BY e.id').all(m);
  const messages = ctx.db.prepare('SELECT m.id, m.dir, m.kind, m.tpl_name, m.body, m.status, m.error_code, m.outcome, m.created_at, m.sent_at, m.automated, u.name sent_by FROM messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.mobile = ? ORDER BY m.created_at, m.id').all(m);
  const imports = ctx.db.prepare('SELECT l.import_id, i.file_name, i.created_at, l.grp, l.bucket, l.track, l.ex_reason, l.reason FROM import_leads l JOIN imports i ON i.id = l.import_id WHERE l.mobile = ? ORDER BY l.import_id').all(m);
  return { mobile: m, customer, optout, suppressions, allowlisted: Opt.isAllowed(ctx.db, m), enrollments, messages, imports };
}

function erase(ctx, mobile, user) {
  must(user, 'customer.erase');
  const m = cleanMobile(mobile); if (!m) throw bad('Not a Bahrain mobile');
  const counts = tx(ctx.db, () => {
    const c = {};
    c.deadLetters = ctx.db.prepare('DELETE FROM dead_letters WHERE message_id IN (SELECT id FROM messages WHERE mobile = ?)').run(m).changes;
    c.messages = ctx.db.prepare('DELETE FROM messages WHERE mobile = ?').run(m).changes;
    c.enrollments = ctx.db.prepare('DELETE FROM enrollments WHERE mobile = ?').run(m).changes;
    c.importRows = ctx.db.prepare('DELETE FROM import_leads WHERE mobile = ?').run(m).changes;
    c.outcomes = ctx.db.prepare('DELETE FROM outcome_events WHERE mobile = ?').run(m).changes;
    c.customer = ctx.db.prepare('DELETE FROM customers WHERE mobile = ?').run(m).changes;
    // webhook payloads hold the number and the text: drop the processed ones for this number
    c.webhookEvents = ctx.db.prepare("DELETE FROM webhook_events WHERE processed_at IS NOT NULL AND payload LIKE ?").run('%' + m.slice(1) + '%').changes;
    return c;
  });
  audit(ctx.db, user, 'customer.erase', m, { ...counts, optOutKept: Opt.isOptedOut(ctx.db, m) });
  return { ...counts, optOutKept: Opt.isOptedOut(ctx.db, m) };
}

module.exports = { search, timeline, erase };
