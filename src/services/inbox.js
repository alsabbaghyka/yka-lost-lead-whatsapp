'use strict';
// The salesperson inbox: customers handed over by the automation. A sales user
// sees the ones assigned to them plus unassigned ones; managers see all.
const { must } = require('../auth');
const { audit } = require('../audit');
const Sender = require('./sender');
const { notFound, err } = require('./errors');

const SQL = `SELECT e.id, e.mobile, e.status, e.brief, e.sales, e.handover_at, e.handover_user, u.name handover_user_name, c.name campaign,
  cu.name customer_name, cu.brand, cu.model, cu.last_inbound_at,
  (SELECT body FROM messages m WHERE m.mobile = e.mobile AND m.dir = 'in' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last_message
  FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id JOIN customers cu ON cu.id = e.customer_id LEFT JOIN users u ON u.id = e.handover_user
  WHERE e.handover_at IS NOT NULL AND e.resolved_at IS NULL`;

async function list(ctx, user) {
  must(user, 'view');
  const rows = user.role === 'sales'
    ? await ctx.db.prepare(SQL + ' AND (e.handover_user = ? OR e.handover_user IS NULL) ORDER BY e.handover_at').all(user.id)
    : await ctx.db.prepare(SQL + ' ORDER BY e.handover_at').all();
  const now = ctx.clock.now();
  return rows.map(r => ({ ...r, window_open: !!(r.last_inbound_at && now - Date.parse(r.last_inbound_at) < 24 * 3600e3),
    window_closes_at: r.last_inbound_at ? new Date(Date.parse(r.last_inbound_at) + 24 * 3600e3).toISOString() : null }));
}
async function load(ctx, id, user) {
  const e = await ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id);
  if (!e || !e.handover_at) throw notFound('Not in the inbox');
  if (user.role === 'sales' && e.handover_user && e.handover_user !== user.id) throw err(403, 'This customer is assigned to another salesperson');
  return e;
}
async function reply(ctx, id, body, user) {
  must(user, 'inbox.reply');
  const text = String(body || '').trim();
  if (!text) throw err(400, 'Write a message first');
  const e = await load(ctx, id, user);
  if (!e.handover_user) await ctx.db.prepare('UPDATE enrollments SET handover_user = ? WHERE id = ?').run(user.id, id);
  const mid = await Sender.enqueueText(ctx, { mobile: e.mobile, enrollmentId: e.id, body: text, user, automated: false });
  await audit(ctx.db, user, 'inbox.reply', e.mobile, { enrollment: id, message: mid });
  return mid;
}
async function resolve(ctx, id, user, note) {
  must(user, 'inbox.reply');
  const e = await load(ctx, id, user);
  await ctx.db.prepare("UPDATE enrollments SET resolved_at = ?, resolved_by = ?, status = CASE WHEN status = 'handover' THEN 'done' ELSE status END, brief = COALESCE(?, brief), updated_at = ? WHERE id = ?")
    .run(ctx.nowIso(), user.id, note ? 'Resolved: ' + String(note).slice(0, 200) : null, ctx.nowIso(), id);
  await audit(ctx.db, user, 'inbox.resolve', e.mobile, { enrollment: id, note });
}
async function assign(ctx, id, userId, user) {
  must(user, 'campaign.control');
  await load(ctx, id, user);
  await ctx.db.prepare('UPDATE enrollments SET handover_user = ? WHERE id = ?').run(userId || null, id);
  await audit(ctx.db, user, 'inbox.assign', String(id), { to: userId });
}
module.exports = { list, reply, resolve, assign };
