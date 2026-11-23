'use strict';
// Campaign lifecycle, scheduler days, reply handling, the salesperson inbox and
// erasure, all against the mock provider with a fake Bahrain clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSystem } = require('./helpers');
const Campaigns = require('../src/services/campaigns');
const Scheduler = require('../src/services/scheduler');
const Sender = require('../src/services/sender');
const Templates = require('../src/services/templates');
const Opt = require('../src/services/optouts');
const Inbox = require('../src/services/inbox');
const Customers = require('../src/services/customers');

const row = (mobile, name, reason, sales = 'S. Kumar', date = '2026-11-20') => ({ 'Mobile No': mobile, 'Customer Name': name, Brand: 'SOUEAST', 'Model Interested': 'S07', 'Lost Reason': reason, 'Created Date': date, 'Sales Consultant': sales });
const ROWS = [
  row('39990001', 'Ali', 'Price too high'),
  row('39990002', 'Hassan', 'Still thinking'),
  row('39990003', 'Yusuf', 'Customer stopped responding'),
  row('39990004', 'Fatima', 'Waiting for stock'),
  row('39990005', 'Old Lead', 'Price', 'S. Kumar', '2026-05-01')
];

async function running(opts = {}) {
  const sys = makeSystem({ now: '2026-12-01T07:00:00Z', ...opts });
  const { ctx, db, users, Settings } = sys;
  Settings.set(db, 'holdout_pct', opts.holdout == null ? 0 : opts.holdout);
  if (opts.live !== false) Settings.set(db, 'go_live', true);
  await Templates.sync(ctx, users.admin);
  const imp = Campaigns.createImport(ctx, { fileName: 'lost.csv', rows: opts.rows || ROWS, user: users.m1 });
  const c = Campaigns.createCampaign(ctx, { importId: imp.importId, name: 'Dec pilot', startDate: '2026-12-02', user: users.m1 });
  Campaigns.submit(ctx, c.id, users.m1);
  Campaigns.approve(ctx, c.id, users.m2);
  Campaigns.start(ctx, c.id, users.m1);
  sys.campaignId = c.id;
  sys.enr = mobile => db.prepare('SELECT * FROM enrollments WHERE mobile = ? AND campaign_id = ?').get(mobile, c.id);
  sys.tpls = mobile => db.prepare("SELECT tpl_key FROM messages WHERE mobile = ? AND dir='out' AND kind='template' AND status NOT IN ('blocked','cancelled') ORDER BY id").all(mobile).map(r => r.tpl_key);
  sys.day = async (isoDate, hhmmUtc = '07:00') => {
    sys.clock.set(`${isoDate}T${hhmmUtc}:00Z`);
    await ctx.pump();
    Scheduler.tick(ctx);
    for (let i = 0; i < 20; i++) { const r = await Sender.processOutbox(ctx); await ctx.pump(); if (!r.sent && !r.retried) break; sys.clock.advance(1000); }
  };
  sys.reply = async (mobile, text, kind) => { ctx.provider.simulateInbound({ from: mobile, text, kind }); await ctx.pump(); for (let i = 0; i < 3; i++) { await Sender.processOutbox(ctx); await ctx.pump(); sys.clock.advance(1000); } };
  return sys;
}

test('four eyes: the builder cannot approve; sales and viewers cannot build', async () => {
  const { ctx, users } = makeSystem();
  await Templates.sync(ctx, users.admin);
  const imp = Campaigns.createImport(ctx, { fileName: 'lost.csv', rows: ROWS, user: users.m1 });
  assert.throws(() => Campaigns.createCampaign(ctx, { importId: imp.importId, name: 'x', startDate: '2026-12-02', user: users.sales }), /not allowed/);
  assert.throws(() => Campaigns.createImport(ctx, { fileName: 'x', rows: ROWS, user: users.viewer }), /not allowed/);
  const c = Campaigns.createCampaign(ctx, { importId: imp.importId, name: 'x', startDate: '2026-12-02', user: users.m1 });
  assert.throws(() => Campaigns.start(ctx, c.id, users.m1), /approved/);
  Campaigns.submit(ctx, c.id, users.m1);
  assert.throws(() => Campaigns.approve(ctx, c.id, users.m1), /someone other than/);
  assert.throws(() => Campaigns.approve(ctx, c.id, users.sales), /not allowed/);
  Campaigns.approve(ctx, c.id, users.m2);
  assert.equal(Campaigns.get(ctx, c.id).campaign.status, 'approved');
  assert.equal(Campaigns.get(ctx, c.id).campaign.approved_by, users.m2.id);
});
test('import preview uses the engine: buckets, tracks and exclusions', async () => {
  const { ctx, users } = makeSystem();
  Opt.addOptout(ctx, '+97339990004', { source: 'manual', user: users.admin });
  const imp = Campaigns.createImport(ctx, { fileName: 'lost.csv', rows: ROWS, user: users.m1 });
  assert.equal(imp.summary.send + imp.summary.holdout, 4);
  assert.equal(imp.summary.excluded, 1);
  assert.equal(imp.summary.exCount.optout, 1);
  const p = Campaigns.preview(ctx, imp.importId);
  assert.equal(p.send.find(l => l.mobile === '+97339990005').track, 'permission');
  assert.equal(p.send.find(l => l.mobile === '+97339990003').bucket, 'noresp');
});
test('Day 0 goes out at the send time, not in quiet hours, then the nudge on Day 2', async () => {
  const s = await running();
  await s.day('2026-12-02', '05:00'); // 08:00 Bahrain: quiet hours
  assert.deepEqual(s.tpls('+97339990001'), []);
  await s.day('2026-12-02', '07:00'); // 10:00 Bahrain
  assert.deepEqual(s.tpls('+97339990001'), ['price']);
  assert.deepEqual(s.tpls('+97339990005'), ['permission'], 'old lead asked first');
  assert.equal(s.enr('+97339990005').status, 'asked');
  await s.day('2026-12-03');
  assert.deepEqual(s.tpls('+97339990001'), ['price']);
});
test('no Friday sends: the Day 2 nudge waits for Saturday', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.day('2026-12-04'); // Friday
  assert.deepEqual(s.tpls('+97339990001'), ['price']);
  await s.day('2026-12-05'); // Saturday
  assert.deepEqual(s.tpls('+97339990001'), ['price', 'nudge']);
});
test('three unanswered messages stop the sequence', async () => {
  const s = await running();
  for (const d of ['02', '05', '06', '07', '08', '09', '10', '11', '12', '15']) await s.day('2026-12-' + d);
  for (let d = 16; d <= 31; d++) await s.day('2026-12-' + d);
  await s.day('2027-01-02');
  assert.deepEqual(s.tpls('+97339990002'), ['thinking', 'nudge', 'voucher']);
  assert.equal(s.enr('+97339990002').status, 'quiet');
});
test('answering 1 to the reason question queues the price message', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.reply('+97339990003', '1');
  assert.equal(s.enr('+97339990003').next_key, 'price');
  const txt = s.db.prepare("SELECT body FROM messages WHERE mobile='+97339990003' AND kind='text' AND dir='out'").get();
  assert.match(txt.body, /finance options/);
  await s.day('2026-12-03'); await s.day('2026-12-05');
  assert.deepEqual(s.tpls('+97339990003'), ['ask', 'price']);
});
test('YES to the permission request starts the bucket message', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.reply('+97339990005', 'Yes please');
  assert.equal(s.enr('+97339990005').status, 'active');
  await s.day('2026-12-05');
  assert.deepEqual(s.tpls('+97339990005'), ['permission', 'price']);
});
test('free text hands over to the named salesperson and pauses automation', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.reply('+97339990001', 'Can you call me about the monthly payment?');
  const e = s.enr('+97339990001');
  assert.equal(e.status, 'handover');
  assert.equal(e.handover_user, s.users.sales.id, 'S. Kumar has a user account');
  const auto = s.db.prepare("SELECT body FROM messages WHERE mobile='+97339990001' AND kind='text' AND dir='out'").get().body;
  assert.equal(auto, 'Thanks Ali. S. Kumar from SOUEAST will contact you shortly.');
  for (const d of ['05', '07', '09', '12', '15']) await s.day('2026-12-' + d);
  assert.deepEqual(s.tpls('+97339990001'), ['price'], 'nothing automated after the handover');
  const inbox = Inbox.list(s.ctx, s.users.sales);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].mobile, '+97339990001');
});
test('salesperson replies inside the 24h window and resolves', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.reply('+97339990001', 'Interested, what is the best price?');
  const e = s.enr('+97339990001');
  const id = Inbox.reply(s.ctx, e.id, 'Hi Ali, I can do 1% lower. Shall I call?', s.users.sales);
  await Sender.processOutbox(s.ctx);
  assert.equal(s.db.prepare('SELECT status, sent_by, automated FROM messages WHERE id = ?').get(id).status, 'accepted');
  s.clock.advance(25 * 3600e3);
  const late = Inbox.reply(s.ctx, e.id, 'Following up', s.users.sales);
  await Sender.processOutbox(s.ctx);
  assert.equal(s.db.prepare('SELECT status FROM messages WHERE id = ?').get(late).status, 'blocked');
  assert.throws(() => Inbox.reply(s.ctx, e.id, 'x', s.users.viewer), /not allowed/);
  Inbox.resolve(s.ctx, e.id, s.users.sales);
  assert.equal(Inbox.list(s.ctx, s.users.sales).length, 0);
  assert.equal(s.enr('+97339990001').status, 'done');
});
test('STOP opts out instantly, across every campaign, and cancels what was queued', async () => {
  const s = await running();
  // a second running campaign holding the same customer
  const imp2 = Campaigns.createImport(s.ctx, { fileName: 'second.csv', rows: [row('39990004', 'Fatima', 'Price')], user: s.users.m1 });
  const c2 = Campaigns.createCampaign(s.ctx, { importId: imp2.importId, name: 'Second', startDate: '2026-12-02', user: s.users.m1 });
  Campaigns.submit(s.ctx, c2.id, s.users.m1); Campaigns.approve(s.ctx, c2.id, s.users.m2); Campaigns.start(s.ctx, c2.id, s.users.m1);
  s.clock.set('2026-12-02T07:00:00Z');
  Scheduler.tick(s.ctx); // queued, not yet sent
  const queued = s.db.prepare("SELECT COUNT(*) n FROM messages WHERE mobile='+97339990004' AND status='queued'").get().n;
  assert.equal(queued, 2, 'one per campaign');
  await s.reply('+97339990004', 'توقف');
  assert.ok(Opt.isOptedOut(s.db, '+97339990004'));
  assert.deepEqual(s.db.prepare("SELECT DISTINCT status FROM enrollments WHERE mobile='+97339990004'").all().map(r => r.status), ['optout']);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE mobile='+97339990004' AND kind='template' AND status IN ('queued','accepted','sent','delivered','read')").get().n, 0);
  const conf = s.db.prepare("SELECT body, status FROM messages WHERE mobile='+97339990004' AND kind='text' AND dir='out'").get();
  assert.match(conf.body, /unsubscribed/); assert.ok(['accepted', 'sent', 'delivered', 'read'].includes(conf.status), 'the confirmation goes, inside the window');
  for (const d of ['05', '09', '15']) await s.day('2026-12-' + d);
  assert.deepEqual(s.tpls('+97339990004'), []);
});
test('"I stopped by the showroom" is not an opt-out', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.reply('+97339990003', 'I stopped by the showroom yesterday, still interested');
  assert.equal(Opt.isOptedOut(s.db, '+97339990003'), false);
  assert.equal(s.enr('+97339990003').status, 'handover');
});
test('a do-not-contact import mid-campaign stops the next message', async () => {
  const s = await running();
  await s.day('2026-12-02');
  Opt.addSuppressions(s.ctx, 'recent_buyer', ['+97339990002'], s.users.m1);
  await s.day('2026-12-05');
  assert.deepEqual(s.tpls('+97339990002'), ['thinking']);
  assert.equal(s.enr('+97339990002').status, 'listed');
});
test('test mode: non-allow-listed customers wait, allow-listed ones are messaged', async () => {
  const s = await running({ live: false });
  Opt.allowlistAdd(s.ctx, '+97339990001', 'IT phone', s.users.admin);
  await s.day('2026-12-02');
  assert.deepEqual(s.tpls('+97339990001'), ['price']);
  assert.deepEqual(s.tpls('+97339990002'), []);
  assert.equal(s.enr('+97339990002').status, 'queued');
  assert.ok(Campaigns.get(s.ctx, s.campaignId).waiting.test_mode >= 4);
});
test('the holdout group is never messaged', async () => {
  const many = Array.from({ length: 40 }, (_, i) => row('3999' + String(2000 + i), 'C' + i, 'Price'));
  const s = await running({ rows: many, holdout: 30 });
  await s.day('2026-12-02'); await s.day('2026-12-05'); await s.day('2026-12-09');
  const hold = s.db.prepare("SELECT mobile FROM enrollments WHERE grp='holdout'").all();
  assert.ok(hold.length > 3);
  hold.forEach(h => assert.deepEqual(s.tpls(h.mobile), []));
});
test('pause stops new sends; resume continues', async () => {
  const s = await running();
  Campaigns.pause(s.ctx, s.campaignId, s.users.m1);
  await s.day('2026-12-02');
  assert.deepEqual(s.tpls('+97339990001'), []);
  Campaigns.resume(s.ctx, s.campaignId, s.users.m2);
  await s.day('2026-12-03');
  assert.deepEqual(s.tpls('+97339990001'), ['price']);
});
test('erasure removes the history but keeps the opt-out, and the number stays unmessageable', async () => {
  const s = await running();
  await s.day('2026-12-02');
  await s.reply('+97339990001', 'STOP');
  Customers.erase(s.ctx, '+97339990001', s.users.admin);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE mobile='+97339990001'").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM customers WHERE mobile='+97339990001'").get().n, 0);
  assert.ok(Opt.isOptedOut(s.db, '+97339990001'));
  const again = Campaigns.createImport(s.ctx, { fileName: 'again.csv', rows: ROWS, user: s.users.m1 });
  assert.equal(again.summary.exCount.optout, 1);
  assert.throws(() => Customers.erase(s.ctx, '+97339990002', s.users.m1), /not allowed/);
});

/* ---------- regressions from the code review ---------- */
test('kill switch: the scheduler does not advance anyone, so steps cannot pile up', async () => {
  const s = await running();
  s.Settings.set(s.db, 'kill_switch', true);
  for (const d of ['02', '05', '07']) await s.day('2026-12-' + d);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='template'").get().n, 0);
  assert.equal(s.enr('+97339990001').tpl_count, 0);
  s.Settings.set(s.db, 'kill_switch', false);
  await s.day('2026-12-08');
  assert.deepEqual(s.tpls('+97339990001'), ['price'], 'one step, not three at once');
});
test('a handover in one campaign stops the customer\'s other campaigns', async () => {
  const s = await running();
  const imp2 = Campaigns.createImport(s.ctx, { fileName: 'second.csv', rows: [row('39990001', 'Ali', 'Waiting for stock')], user: s.users.m1 });
  const c2 = Campaigns.createCampaign(s.ctx, { importId: imp2.importId, name: 'Second', startDate: '2026-12-02', user: s.users.m1 });
  Campaigns.submit(s.ctx, c2.id, s.users.m1); Campaigns.approve(s.ctx, c2.id, s.users.m2); Campaigns.start(s.ctx, c2.id, s.users.m1);
  await s.day('2026-12-02');
  await s.reply('+97339990001', 'Can someone call me?');
  const states = s.db.prepare("SELECT status FROM enrollments WHERE mobile='+97339990001' ORDER BY id").all().map(r => r.status);
  assert.deepEqual(states, ['done', 'handover']);
  for (const d of ['05', '09', '15']) await s.day('2026-12-' + d);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE mobile='+97339990001' AND kind='template' AND created_at > '2026-12-03'").get().n, 0);
});
test('a template blocked at send time is not counted as sent; the step is offered again', async () => {
  const s = await running();
  s.clock.set('2026-12-02T07:00:00Z');
  Scheduler.tick(s.ctx);                              // queued while live
  s.Settings.set(s.db, 'go_live', false);             // back to test mode before it leaves
  await Sender.processOutbox(s.ctx);
  const e = s.enr('+97339990001');
  assert.equal(s.db.prepare("SELECT status FROM messages WHERE mobile='+97339990001'").get().status, 'blocked');
  assert.deepEqual([e.status, e.tpl_count, e.unanswered, e.next_key], ['queued', 0, 0, 'price']);
  s.Settings.set(s.db, 'go_live', true);
  await s.day('2026-12-03');
  assert.deepEqual(s.tpls('+97339990001'), ['price']);
});
test('erasing a customer with a reply still in the webhook queue does not bring it back', async () => {
  const s = await running();
  await s.day('2026-12-02');
  s.ctx.provider.simulateInbound({ from: '+97339990002', text: 'please stop' });
  await s.ctx.provider.flush();                        // stored, not processed
  Customers.erase(s.ctx, '+97339990002', s.users.admin);
  await s.ctx.processWebhooks();
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE mobile='+97339990002'").get().n, 0);
  assert.ok(Opt.isOptedOut(s.db, '+97339990002'), 'the STOP in the queue was still honoured');
});
