'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/webhook');
const P = require('../src/providers/payloads');
const { makeSystem } = require('./helpers');
const { createContext } = require('../src/context');

const signed = (ctx, payload) => { const raw = JSON.stringify(payload); return { raw, headers: { 'x-hub-signature-256': P.sign(raw, ctx.cfg.appSecret) } }; };
const pending = db => db.prepare('SELECT COUNT(*) n FROM webhook_events WHERE processed_at IS NULL').get().n;

test('GET verification echoes the challenge only with the right token', () => {
  const { cfg } = makeSystem();
  assert.deepEqual(W.verifyChallenge(cfg, { 'hub.mode': 'subscribe', 'hub.verify_token': cfg.verifyToken, 'hub.challenge': '1158201444' }), { status: 200, body: '1158201444' });
  assert.equal(W.verifyChallenge(cfg, { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).status, 403);
  assert.equal(W.verifyChallenge(cfg, { 'hub.mode': 'unsubscribe', 'hub.verify_token': cfg.verifyToken, 'hub.challenge': '1' }).status, 403);
});
test('POST with a bad or missing signature is rejected and nothing is stored', async () => {
  const { ctx, db } = makeSystem();
  const raw = JSON.stringify(P.inboundPayload({ from: '+97339991000', id: 'wamid.in1', timestamp: 1, text: 'hi' }));
  assert.equal((await W.receive(ctx, raw, { 'x-hub-signature-256': P.sign(raw, 'not-the-secret') })).status, 401);
  assert.equal((await W.receive(ctx, raw, {})).status, 401);
  assert.equal((await W.receive(ctx, raw + ' ', { 'x-hub-signature-256': P.sign(raw, ctx.cfg.appSecret) })).status, 401, 'signature covers the raw bytes');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n, 0);
});
test('signature check is constant-time safe on odd input', () => {
  assert.equal(W.verifySignature('s', 'body', 'sha256=zz'), false);
  assert.equal(W.verifySignature('s', 'body', 'md5=abc'), false);
  assert.equal(W.verifySignature('', 'body', P.sign('body', '')), false, 'no secret configured never verifies');
});
test('a retried delivery is stored once (idempotent on ids)', async () => {
  const { ctx, db } = makeSystem();
  const { raw, headers } = signed(ctx, P.statusPayload({ wamid: 'wamid.1', status: 'delivered', to: '+97339991000', timestamp: 5 }));
  assert.equal((await W.receive(ctx, raw, headers)).status, 200);
  assert.equal((await W.receive(ctx, raw, headers)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n, 1);
  const { raw: r2, headers: h2 } = signed(ctx, P.statusPayload({ wamid: 'wamid.1', status: 'read', to: '+97339991000', timestamp: 6 }));
  await W.receive(ctx, r2, h2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n, 2, 'a new status for the same message is a new event');
});
test('200 comes back before processing; unprocessed events survive a restart', async () => {
  const { ctx, db } = makeSystem();
  db.prepare("INSERT INTO customers(mobile, first_seen, last_seen) VALUES ('+97339991000', 'x', 'x')").run();
  const { raw, headers } = signed(ctx, P.inboundPayload({ from: '+97339991000', id: 'wamid.in2', timestamp: 1764658800, text: 'hello' }));
  const r = await W.receive(ctx, raw, headers);
  assert.equal(r.status, 200);
  assert.equal(pending(db), 1, 'stored, not yet processed');
  const ctx2 = createContext({ cfg: ctx.cfg, db, clock: ctx.clock }); // "after a restart"
  await W.processPending(ctx2);
  assert.equal(pending(db), 0);
  assert.equal(db.prepare("SELECT body FROM messages WHERE wamid = 'wamid.in2'").get().body, 'hello');
});
test('inbound text, quick-reply button and interactive replies are all read as text', async () => {
  const { ctx, db } = makeSystem();
  db.prepare("INSERT INTO customers(mobile, first_seen, last_seen) VALUES ('+97339991000', 'x', 'x')").run();
  const kinds = [['text', 'hello'], ['button', 'Unsubscribe'], ['button_reply', 'Yes'], ['list_reply', '2']];
  for (const [i, [kind, text]] of kinds.entries()) {
    const { raw, headers } = signed(ctx, P.inboundPayload({ from: '+97339991000', id: 'wamid.k' + i, timestamp: 1764658800 + i, kind, text }));
    await W.receive(ctx, raw, headers);
  }
  await W.processPending(ctx);
  assert.deepEqual(db.prepare("SELECT kind, body FROM messages WHERE dir='in' ORDER BY id").all().map(r => [r.kind, r.body]),
    [['text', 'hello'], ['button', 'Unsubscribe'], ['interactive', 'Yes'], ['interactive', '2']]);
  assert.ok(db.prepare("SELECT 1 FROM optouts WHERE mobile='+97339991000'").get(), 'the Unsubscribe button opted them out');
  assert.equal(db.prepare("SELECT last_inbound_at FROM customers").get().last_inbound_at, new Date((1764658800 + 3) * 1000).toISOString());
});
test('a message from an unknown number is kept but not acted on; another phone number id is ignored', async () => {
  const { ctx, db } = makeSystem({ env: { WA_PHONE_NUMBER_ID: '111' } });
  const a = signed(ctx, P.inboundPayload({ phoneNumberId: '111', from: '+97339990000', id: 'wamid.u1', timestamp: 1, text: 'STOP' }));
  const b = signed(ctx, P.inboundPayload({ phoneNumberId: '999', from: '+97339990001', id: 'wamid.u2', timestamp: 1, text: 'STOP' }));
  await W.receive(ctx, a.raw, a.headers); await W.receive(ctx, b.raw, b.headers);
  await W.processPending(ctx);
  assert.ok(db.prepare("SELECT 1 FROM optouts WHERE mobile='+97339990000'").get(), 'a STOP is honoured even from someone not in a campaign');
  assert.equal(db.prepare("SELECT 1 FROM optouts WHERE mobile='+97339990001'").get(), undefined, 'not our number');
  assert.match(db.prepare("SELECT error FROM webhook_events WHERE event_key LIKE '%wamid.u2'").get().error, /phone number id/);
});
test('template status updates change the stored approval', async () => {
  const { ctx, db } = makeSystem();
  db.prepare("INSERT INTO templates(name, language, status) VALUES ('lost_lead_price_v1', 'en', 'APPROVED')").run();
  const { raw, headers } = signed(ctx, P.templateStatusPayload({ name: 'lost_lead_price_v1', language: 'en', event: 'PAUSED', reason: 'NONE' }));
  await W.receive(ctx, raw, headers); await W.processPending(ctx);
  assert.equal(db.prepare("SELECT status FROM templates WHERE name='lost_lead_price_v1'").get().status, 'PAUSED');
});
test('malformed JSON with a valid signature is acknowledged and logged, not retried forever', async () => {
  const { ctx, db } = makeSystem();
  const raw = '{not json';
  const r = await W.receive(ctx, raw, { 'x-hub-signature-256': P.sign(raw, ctx.cfg.appSecret) });
  assert.equal(r.status, 200, 'a non-200 makes Meta retry for 7 days');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'webhook.malformed'").get());
});
