'use strict';
// Every safety gate between the database and WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSystem, H, D } = require('./helpers');
const Sender = require('../src/services/sender');
const Templates = require('../src/services/templates');
const Opt = require('../src/services/optouts');

const MOB = '+97339991000';
async function ready(opts = {}) {
  const sys = (await makeSystem(opts));
  const { ctx, db, Settings } = sys;
  await Templates.sync(ctx, sys.users.admin);
  (await Settings.set(db, 'go_live', true));
  sys.cust = (await db.prepare("INSERT INTO customers(mobile, name, first_seen, last_seen) VALUES (?, 'Ali', 'x', 'x') RETURNING id").get(MOB)).id;
  sys.tpl = async (mobile = MOB, idem) => (await Sender.enqueueTemplate(ctx, { mobile, key: 'price', tplName: 'lost_lead_price_v1', vars: ['Ali', 'SOUEAST', 'S07'], idemKey: idem || 'k-' + Math.random() }));
  sys.msg = async id => (await db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  return sys;
}

test('a template is sent when every gate is open', async () => {
  const s = await ready();
  const id = (await s.tpl());
  const r = await Sender.processOutbox(s.ctx);
  assert.equal(r.sent, 1);
  const m = (await s.msg(id));
  assert.equal(m.status, 'accepted'); assert.match(m.wamid, /^wamid\./); assert.ok(m.sent_at);
  await s.ctx.pump();
  assert.equal((await s.msg(id)).status, 'read', 'mock webhooks moved it on');
});
test('idempotency key: the same (customer, step) is queued once', async () => {
  const s = await ready();
  const a = (await s.tpl(MOB, 'enr:1:t1')), b = (await s.tpl(MOB, 'enr:1:t1'));
  assert.ok(a); assert.equal(b, null);
});
test('kill switch holds everything; releasing it sends', async () => {
  const s = await ready();
  s.Settings.set(s.db, 'kill_switch', true);
  const id = (await s.tpl());
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 0);
  assert.equal((await s.msg(id)).status, 'queued');
  s.Settings.set(s.db, 'kill_switch', false);
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 1);
});
test('test mode: only allow-listed numbers receive anything', async () => {
  const s = await ready();
  s.Settings.set(s.db, 'go_live', false);
  const blocked = (await s.tpl(MOB));
  (await Opt.allowlistAdd(s.ctx, '+97339990777', 'IT test phone', s.users.admin));
  (await s.db.prepare("INSERT INTO customers(mobile, first_seen, last_seen) VALUES ('+97339990777', 'x', 'x')").run());
  const allowed = (await s.tpl('+97339990777'));
  const r = await Sender.processOutbox(s.ctx);
  assert.equal(r.sent, 1);
  assert.equal((await s.msg(blocked)).status, 'blocked'); assert.match((await s.msg(blocked)).outcome, /test mode/i);
  assert.equal((await s.msg(allowed)).status, 'accepted');
});
test('an opt-out stops a message that was already queued', async () => {
  const s = await ready();
  const id = (await s.tpl());
  (await Opt.addOptout(s.ctx, MOB, { source: 'manual', user: s.users.admin }));
  await Sender.processOutbox(s.ctx);
  assert.ok(['cancelled', 'blocked'].includes((await s.msg(id)).status));
  assert.equal(s.ctx.provider.sent.length, 0);
});
test('do-not-contact list blocks templates', async () => {
  const s = await ready();
  (await Opt.addSuppressions(s.ctx, 'dnc', [MOB], s.users.admin));
  const id = (await s.tpl());
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(id)).status, 'blocked'); assert.match((await s.msg(id)).outcome, /do-not-contact/i);
});
test('holdout customers are refused even if something queues them', async () => {
  const s = await ready();
  const camp = (await s.db.prepare("INSERT INTO imports(file_name, created_at, row_count, mapping, options, summary) VALUES ('f','x',0,'{}','{}','{}') RETURNING id").get()).id;
  const c = (await s.db.prepare("INSERT INTO campaigns(name, import_id, status, start_date, created_by, created_at) VALUES ('c', ?, 'running', '2026-12-02', ?, 'x') RETURNING id").get(camp, s.users.m1.id)).id;
  const e = (await s.db.prepare("INSERT INTO enrollments(campaign_id, customer_id, mobile, grp, bucket, track, status, updated_at) VALUES (?, ?, ?, 'holdout', 'price', 'standard', 'holdout', 'x') RETURNING id").get(c, s.cust, MOB)).id;
  const id = (await Sender.enqueueTemplate(s.ctx, { mobile: MOB, enrollmentId: e, key: 'price', tplName: 'lost_lead_price_v1', vars: [], idemKey: 'h1' }));
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(id)).status, 'blocked'); assert.match((await s.msg(id)).outcome, /holdout/i);
  assert.equal(s.ctx.provider.sent.length, 0);
});
test('unknown, pending and rejected templates are refused', async () => {
  const s = await ready();
  (await s.db.prepare("UPDATE templates SET status = 'PENDING' WHERE name = 'lost_lead_price_v1'").run());
  const a = (await s.tpl());
  const b = (await Sender.enqueueTemplate(s.ctx, { mobile: MOB, key: 'x', tplName: 'never_submitted_v1', vars: [], idemKey: 'u1' }));
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(a)).status, 'blocked'); assert.match((await s.msg(a)).outcome, /PENDING/);
  assert.equal((await s.msg(b)).status, 'blocked'); assert.match((await s.msg(b)).outcome, /not approved|unknown/i);
  assert.equal(s.ctx.provider.sent.length, 0);
});
test('free text only inside the 24-hour customer service window', async () => {
  const s = await ready();
  const out = (await Sender.enqueueText(s.ctx, { mobile: MOB, body: 'Hello', user: s.users.sales }));
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(out)).status, 'blocked'); assert.match((await s.msg(out)).outcome, /24-hour/);
  (await s.db.prepare('UPDATE customers SET last_inbound_at = ? WHERE id = ?').run(new Date(s.clock.now() - 23 * H).toISOString(), s.cust));
  const inside = (await Sender.enqueueText(s.ctx, { mobile: MOB, body: 'Hello again', user: s.users.sales }));
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(inside)).status, 'accepted');
});
test('daily cap counts templates per Bahrain day', async () => {
  const s = await ready();
  s.Settings.set(s.db, 'daily_cap', 2);
  const ids = [await s.tpl(), await s.tpl(), await s.tpl()];
  await Sender.processOutbox(s.ctx);
  assert.deepEqual((await Promise.all(ids.map(i => s.msg(i)))).map(m => m.status), ['accepted', 'accepted', 'queued']);
  s.clock.advance(D);
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(ids[2])).status, 'accepted', 'goes out the next day');
});
test('automated templates wait out Fridays and quiet hours; a person replying does not', async () => {
  const s = await ready({ now: '2026-12-04T07:00:00Z' }); // Friday 10:00 Bahrain
  const id = (await s.tpl());
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(id)).status, 'queued');
  (await s.db.prepare('UPDATE customers SET last_inbound_at = ?').run(new Date(s.clock.now() - H).toISOString()));
  const human = (await Sender.enqueueText(s.ctx, { mobile: MOB, body: 'Sure, see you Saturday', user: s.users.sales }));
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(human)).status, 'accepted');
  s.clock.set('2026-12-04T19:00:00Z'); // Friday 22:00 -> still Friday
  await Sender.processOutbox(s.ctx); assert.equal((await s.msg(id)).status, 'queued');
  s.clock.set('2026-12-05T03:00:00Z'); // Saturday 06:00, quiet hours
  await Sender.processOutbox(s.ctx); assert.equal((await s.msg(id)).status, 'queued');
  s.clock.set('2026-12-05T06:30:00Z'); // Saturday 09:30
  await Sender.processOutbox(s.ctx); assert.equal((await s.msg(id)).status, 'accepted');
});
test('throttle: no more than max_per_second in any second', async () => {
  const s = await ready();
  s.Settings.set(s.db, 'max_per_second', 3);
  for (let i = 0; i < 7; i++) (await s.tpl());
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 3);
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 0, 'same second');
  s.clock.advance(1000);
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 3);
});
test('rate limit and 5xx retry with exponential backoff, then dead-letter', async () => {
  const s = await ready();
  s.Settings.set(s.db, 'max_attempts', 3);
  const id = (await s.tpl());
  s.ctx.provider.failNext({ code: 130429 });
  await Sender.processOutbox(s.ctx);
  let m = (await s.msg(id));
  assert.equal(m.status, 'queued'); assert.equal(m.attempts, 1);
  const wait1 = Date.parse(m.next_attempt_at) - s.clock.now();
  assert.equal(wait1, 2000);
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 0, 'not before the backoff');
  s.clock.advance(wait1);
  s.ctx.provider.failNext({ http: 503 });
  await Sender.processOutbox(s.ctx);
  m = (await s.msg(id)); assert.equal(m.attempts, 2);
  assert.equal(Date.parse(m.next_attempt_at) - s.clock.now(), 4000, 'doubles');
  s.clock.advance(4000);
  s.ctx.provider.failNext({ code: 131000 });
  await Sender.processOutbox(s.ctx);
  m = (await s.msg(id)); assert.equal(m.status, 'failed');
  assert.ok((await s.db.prepare('SELECT 1 FROM dead_letters WHERE message_id = ?').get(id)));
});
test('a dead letter can be retried by an admin', async () => {
  const s = await ready();
  s.Settings.set(s.db, 'max_attempts', 1);
  const id = (await s.tpl());
  s.ctx.provider.failNext({ code: 131000 });
  await Sender.processOutbox(s.ctx);
  const dl = (await s.db.prepare('SELECT id FROM dead_letters WHERE message_id = ?').get(id)).id;
  (await Sender.retryDeadLetter(s.ctx, dl, s.users.admin));
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(id)).status, 'accepted');
  assert.ok((await s.db.prepare('SELECT resolved_at FROM dead_letters WHERE id = ?').get(dl)).resolved_at);
});
test('permanent errors are not retried', async () => {
  const s = await ready();
  const id = (await s.tpl());
  s.ctx.provider.failNext({ code: 131049 });
  await Sender.processOutbox(s.ctx);
  const m = (await s.msg(id));
  assert.equal(m.status, 'failed'); assert.equal(m.attempts, 1); assert.equal(m.error_code, 131049);
  assert.match(m.outcome, /Meta held/);
  assert.equal((await s.db.prepare('SELECT COUNT(*) n FROM dead_letters').get()).n, 0);
});
test('131050 (customer stopped marketing messages) is treated as an opt-out', async () => {
  const s = await ready();
  (await s.tpl()); s.ctx.provider.failNext({ code: 131050 });
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.db.prepare('SELECT source FROM optouts WHERE mobile = ?').get(MOB)).source, 'meta_131050');
});
test('an account error (expired token) halts the queue until an admin resumes it', async () => {
  const s = await ready();
  const a = (await s.tpl()), b = (await s.tpl());
  s.ctx.provider.failNext({ code: 190 });
  await Sender.processOutbox(s.ctx);
  assert.equal((await s.msg(a)).status, 'queued'); assert.equal((await s.msg(a)).attempts, 0, 'not the message\'s fault');
  assert.ok((await Sender.halted(s.ctx)));
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 0);
  (await Sender.resume(s.ctx, s.users.admin));
  assert.equal((await Sender.processOutbox(s.ctx)).sent, 2);
  assert.equal((await s.msg(b)).status, 'accepted');
});
test('undeliverable (131026 by webhook) is recorded and never retried', async () => {
  const s = await ready();
  s.ctx.provider.unreachable.add(MOB);
  const id = (await s.tpl());
  await Sender.processOutbox(s.ctx);
  await s.ctx.pump();
  const m = (await s.msg(id));
  assert.equal(m.status, 'failed'); assert.equal(m.error_code, 131026); assert.match(m.outcome, /not on WhatsApp/);
  await Sender.processOutbox(s.ctx);
  assert.equal(s.ctx.provider.sent.length, 1);
});
