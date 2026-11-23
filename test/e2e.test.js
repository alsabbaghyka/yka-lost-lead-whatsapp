'use strict';
// End to end, through the HTTP API of a real server with the mock provider and
// a fake Bahrain clock:
//   engine sample import -> build (marketing A) -> approve (marketing B) -> start
//   -> Day 0 sends -> signed delivery/read webhooks come back -> STOP opts out
//   -> free text hands over to the salesperson -> reply inside 24h -> Day 2 on Saturday
//   -> outcome file -> results numbers match a hand computation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../src/runtime');
const { fakeClock } = require('../src/clock');
const Auth = require('../src/auth');
const Scheduler = require('../src/services/scheduler');
const Sender = require('../src/services/sender');
const { compareArms, minDetectable } = require('../src/rules/stats');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lle-e2e-'));
const clock = fakeClock('2026-12-02T07:00:00Z'); // Wednesday 10:00 in Bahrain
let sys, base;
test.before(async () => {
  sys = await start({ env: { WA_PROVIDER: 'mock', DB_PATH: path.join(dir, 'e2e.db'), PORT: '0' }, clock, workers: false });
  base = `http://127.0.0.1:${sys.server.address().port}`;
  const mk = async (email, name, role) => (await Auth.createUser(sys.ctx.db, { email, name, role, password: 'long enough password' }));
  mk('admin@e2e', 'IT Admin', 'admin'); mk('amina@e2e', 'Amina', 'marketing'); mk('bilal@e2e', 'Bilal', 'marketing'); mk('kumar@e2e', 'S. Kumar', 'sales');
});
test.after(async () => { await sys.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'long enough password' }) });
  assert.equal(r.status, 200);
  const b = await r.json();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, url, body, raw) => {
    const res = await fetch(base + url, { method, body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
      headers: { Cookie: cookie, 'X-CSRF-Token': b.csrf, ...(raw ? raw.headers : body ? { 'Content-Type': 'application/json' } : {}) } });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}
/** what the background workers do, on demand */
async function work() {
  for (let i = 0; i < 30; i++) {
    await sys.ctx.provider.flush(); await sys.ctx.processWebhooks();
    const r = await Sender.processOutbox(sys.ctx);
    await sys.ctx.provider.flush(); await sys.ctx.processWebhooks();
    if (!r.sent && !r.retried) break;
    clock.advance(1000);
  }
}
const q = async (sql, ...a) => (await sys.ctx.db.prepare(sql).all(...a));

test('the whole loop, end to end', async () => {
  let admin = await login('admin@e2e'), amina = await login('amina@e2e'), bilal = await login('bilal@e2e'), kumar = await login('kumar@e2e');

  // safety first: test mode is on, so go live for the run (an admin decision, audited)
  assert.equal((await admin('GET', '/api/settings')).values.go_live, false);
  await admin('PUT', '/api/settings', { go_live: true });
  const sync = await admin('POST', '/api/templates/sync');
  assert.ok(sync.approved >= 8);

  // 1. the engine's sample through the import screen's API
  const imp = await amina('POST', '/api/imports/sample');
  assert.deepEqual([imp.summary.total, imp.summary.unique, imp.summary.excluded, imp.summary.holdout, imp.summary.meta, imp.summary.send], [160, 148, 31, 12, 11, 106]);

  // 2. four eyes
  const c = await amina('POST', '/api/campaigns', { importId: imp.importId, name: 'E2E pilot', startDate: '2026-12-02' });
  await amina('POST', `/api/campaigns/${c.id}/submit`);
  await assert.rejects(amina('POST', `/api/campaigns/${c.id}/approve`), /someone other than/);
  await bilal('POST', `/api/campaigns/${c.id}/approve`);
  const started = await amina('POST', `/api/campaigns/${c.id}/start`);
  assert.equal(started.enrolled, 106 + (await q("SELECT COUNT(*) n FROM import_leads WHERE grp='holdout'"))[0].n);

  // 3. Day 0: every send-group customer gets one template; holdout gets nothing
  (await Scheduler.tick(sys.ctx)); await work();
  let d = await admin('GET', `/api/campaigns/${c.id}`);
  assert.equal((d.funnel.read || 0) + (d.funnel.delivered || 0), 106, 'all 106 Day-0 templates came back read/delivered by webhook');
  assert.equal((await q("SELECT COUNT(*) n FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.grp = 'holdout'"))[0].n, 0);
  // the sample's leads are all from before the consent date: permission first
  assert.equal((await q("SELECT COUNT(*) n FROM messages WHERE kind='template' AND tpl_name='lost_lead_permission_v1'"))[0].n, 106);
  assert.equal(d.statuses.asked, 106);

  const sendList = (await q("SELECT mobile FROM enrollments WHERE campaign_id = ? AND grp = 'send' ORDER BY id", c.id)).map(r => r.mobile);
  const [stopper, chatter, yes, no] = sendList;

  // 4. replies come back through signed webhooks
  await admin('POST', '/api/dev/simulate-reply', { mobile: stopper, text: 'STOP' });
  await admin('POST', '/api/dev/simulate-reply', { mobile: chatter, text: 'Is the S07 still available in white? What is the price?' });
  await admin('POST', '/api/dev/simulate-reply', { mobile: yes, text: 'YES' });
  await admin('POST', '/api/dev/simulate-reply', { mobile: no, text: 'No' });
  await work();

  const opt = await admin('GET', '/api/optouts');
  assert.deepEqual(opt.map(o => o.mobile), [stopper]);
  const stopT = await admin('GET', '/api/customers/' + encodeURIComponent(stopper));
  assert.equal(stopT.enrollments[0].status, 'optout');
  assert.match(stopT.messages.at(-1).body, /unsubscribed/);

  // 5. the handover reaches S. Kumar's inbox; he replies inside the window and resolves
  const inbox = await kumar('GET', '/api/inbox');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].mobile, chatter);
  assert.equal(inbox[0].handover_user_name, 'S. Kumar');
  assert.equal(inbox[0].window_open, true);
  await kumar('POST', `/api/inbox/${inbox[0].id}/reply`, { body: 'Yes, two white S07s arrive next week. Can I call you?' });
  await work();
  const chatT = await kumar('GET', '/api/customers/' + encodeURIComponent(chatter));
  const human = chatT.messages.filter(m => m.dir === 'out' && !m.automated);
  assert.equal(human.length, 1); assert.equal(human[0].sent_by, 'S. Kumar'); assert.ok(['accepted', 'sent', 'delivered', 'read'].includes(human[0].status));
  await kumar('POST', `/api/inbox/${inbox[0].id}/resolve`, { note: 'test drive booked' });
  assert.equal((await kumar('GET', '/api/inbox')).length, 0);

  // 6. Day 2 is Friday: nothing. Saturday: YES gets the bucket message; everyone else stays at 1 template (asked)
  clock.set('2026-12-04T07:00:00Z'); (await Scheduler.tick(sys.ctx)); await work();
  assert.equal((await q("SELECT COUNT(*) n FROM messages WHERE kind='template' AND created_at >= '2026-12-04'"))[0].n, 0, 'no Friday sends');
  clock.set('2026-12-05T07:00:00Z'); (await Scheduler.tick(sys.ctx)); await work();
  const yesT = (await q("SELECT tpl_key FROM messages WHERE mobile = ? AND kind='template' ORDER BY id", yes)).map(r => r.tpl_key);
  assert.equal(yesT.length, 2); assert.equal(yesT[0], 'permission');
  assert.equal((await q("SELECT status FROM enrollments WHERE mobile = ?", no))[0].status, 'declined');
  assert.equal((await q("SELECT COUNT(*) n FROM messages WHERE mobile = ? AND dir='out'", stopper))[0].n, 2, 'Day 0 and the unsubscribe confirmation, nothing after');

  // 7. results: an outcome file (invoices) 3 weeks later. Sessions last 12 hours, so sign in again.
  await assert.rejects(admin('GET', '/api/me'), /401/, 'yesterday\'s session has expired');
  admin = await login('admin@e2e'); amina = await login('amina@e2e'); bilal = await login('bilal@e2e');
  const holdList = (await q("SELECT mobile FROM enrollments WHERE campaign_id = ? AND grp = 'holdout' UNION SELECT mobile FROM import_leads WHERE import_id = ? AND grp = 'meta_holdout'", c.id, imp.importId)).map(r => r.mobile);
  const buyers = [...sendList.slice(10, 22), holdList[0]];            // 12 messaged, 1 holdout
  const csv = 'Invoice No,Customer Mobile,Invoice Date\n' + buyers.map((m, i) => `INV${i},${m.slice(4)},2${i % 2}/12/2026`).join('\n') + '\nINV99,39998877,21/12/2026\n';
  const up = await admin('POST', '/api/uploads', null, { body: csv, headers: { 'X-File-Name': 'invoices.csv', 'Content-Type': 'application/octet-stream' } });
  const oi = await admin('POST', '/api/outcomes/import', { uploadId: up.uploadId });
  assert.equal(oi.mobiles, 14);
  const r = await bilal('GET', `/api/campaigns/${c.id}/results?window=60`);
  assert.equal(r.ready, true);
  assert.deepEqual([r.messaged.n, r.messaged.conv, r.holdout.n, r.holdout.conv], [106, 12, 12, 1]);
  const want = compareArms({ n: 106, conv: 12 }, { n: 12, conv: 1 });
  assert.ok(Math.abs(r.compare.p - want.p) < 1e-12 && Math.abs(r.compare.diff - want.diff) < 1e-12);
  assert.ok(Math.abs(r.mde - minDetectable(106, 12, 1 / 12)) < 1e-12);
  assert.equal(r.verdict.significant, false);
  assert.match(r.verdict.headline, /^Not proven either way\. Messaged 11\.3% against holdout 8\.3% is \+3\.0 pts/);
  assert.equal(r.matched, 13);

  // 8. CRM write-back and the audit trail
  const crm = await amina('GET', `/api/campaigns/${c.id}/export/crm`);
  assert.match(crm, new RegExp(`${stopper.replace('+', '\\+')},[^\\n]*Opted out[^\\n]*,yes`));
  const audit = await admin('GET', '/api/audit?limit=1000');
  for (const a of ['campaign.create', 'campaign.submit', 'campaign.approve', 'campaign.start', 'optout.add', 'handover', 'inbox.reply', 'inbox.resolve', 'outcomes.import', 'settings.update'])
    assert.ok(audit.some(x => x.action === a), 'audited: ' + a);
  assert.ok(!JSON.stringify(audit).includes(stopper.slice(4)), 'no raw mobile in the audit log');
});
