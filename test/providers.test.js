'use strict';
// The Cloud provider is tested against the request/response shapes in Meta's
// documentation (docs/META-API-NOTES.md) with a fake fetch. Nothing here talks to Meta.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { classifyError } = require('../src/providers/errors');
const { CloudProvider } = require('../src/providers/cloud');
const { MockProvider } = require('../src/providers/mock');
const { DryRunProvider } = require('../src/providers/dryrun');
const P = require('../src/providers/payloads');

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  fn.calls = calls;
  return fn;
}
const cfg = { graphBase: 'https://graph.facebook.com', graphVersion: 'v27.0', accessToken: 'TEST-TOKEN', phoneNumberId: '1065', wabaId: '2020' };

test('cloud: template send matches the documented body and URL', async () => {
  const f = fakeFetch([{ status: 200, json: { messaging_product: 'whatsapp', contacts: [{ input: '+97339991000', wa_id: '97339991000' }], messages: [{ id: 'wamid.ABC' }] } }]);
  const p = new CloudProvider(cfg, { fetch: f });
  const r = await p.sendTemplate({ to: '+97339991000', name: 'lost_lead_price_v1', language: 'en', params: ['Ali', 'SOUEAST', 'S07'] });
  assert.deepEqual(r, { ok: true, wamid: 'wamid.ABC', waId: '97339991000', pacing: null });
  const c = f.calls[0];
  assert.equal(c.url, 'https://graph.facebook.com/v27.0/1065/messages');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer TEST-TOKEN');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '+97339991000', type: 'template',
    template: { name: 'lost_lead_price_v1', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ali' }, { type: 'text', text: 'SOUEAST' }, { type: 'text', text: 'S07' }] }] } });
});
test('cloud: a template with no variables sends no components', async () => {
  const f = fakeFetch([{ status: 200, json: { messages: [{ id: 'wamid.X', message_status: 'accepted' }] } }]);
  const r = await new CloudProvider(cfg, { fetch: f }).sendTemplate({ to: '+97339991000', name: 't', language: 'en', params: [] });
  assert.equal(f.calls[0].body.template.components, undefined);
  assert.equal(r.pacing, 'accepted');
});
test('cloud: free text body', async () => {
  const f = fakeFetch([{ status: 200, json: { messages: [{ id: 'wamid.T' }] } }]);
  await new CloudProvider(cfg, { fetch: f }).sendText({ to: '+97339991000', body: 'Thanks Ali.' });
  assert.deepEqual(f.calls[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '+97339991000', type: 'text', text: { preview_url: false, body: 'Thanks Ali.' } });
});
test('cloud: errors come back classified, never thrown', async () => {
  const err = (code, details) => ({ status: 400, json: { error: { message: `(#${code}) x`, type: 'OAuthException', code, error_data: { messaging_product: 'whatsapp', details }, fbtrace_id: 'F' } } });
  const f = fakeFetch([err(130429, 'Cloud API message throughput has been reached.'), err(131026, 'undeliverable'), { status: 503, json: {} }, new Error('ECONNRESET'), { status: 401, json: { error: { code: 190, message: 'expired' } } }]);
  const p = new CloudProvider(cfg, { fetch: f });
  const send = () => p.sendTemplate({ to: '+97339991000', name: 't', language: 'en', params: [] });
  const a = await send(); assert.equal(a.ok, false); assert.equal(a.error.code, 130429); assert.equal(a.error.kind, 'retry');
  const b = await send(); assert.equal(b.error.kind, 'permanent'); assert.equal(b.error.undeliverable, true);
  const c = await send(); assert.equal(c.error.kind, 'retry'); assert.equal(c.error.http, 503);
  const d = await send(); assert.equal(d.error.kind, 'retry'); assert.equal(d.error.network, true);
  const e = await send(); assert.equal(e.error.kind, 'account');
});
test('cloud: template sync follows paging.next', async () => {
  const page1 = { data: [{ id: '1', name: 'lost_lead_price_v1', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }],
    paging: { cursors: { after: 'A' }, next: 'https://graph.facebook.com/v27.0/2020/message_templates?after=A' } };
  const page2 = { data: [{ id: '2', name: 'lost_lead_stock_v1', language: 'en_US', status: 'PENDING', category: 'MARKETING', components: [] }], paging: { cursors: {} } };
  const f = fakeFetch([{ status: 200, json: page1 }, { status: 200, json: page2 }]);
  const list = await new CloudProvider(cfg, { fetch: f }).listTemplates();
  assert.match(f.calls[0].url, /^https:\/\/graph\.facebook\.com\/v27\.0\/2020\/message_templates\?/);
  assert.match(f.calls[0].url, /fields=/);
  assert.equal(f.calls[1].url, page1.paging.next);
  assert.deepEqual(list.map(t => [t.name, t.language, t.status, t.body]), [['lost_lead_price_v1', 'en', 'APPROVED', 'Hi {{1}}'], ['lost_lead_stock_v1', 'en_US', 'PENDING', '']]);
});
test('cloud: test connection reports a clear failure', async () => {
  const f = fakeFetch([{ status: 401, json: { error: { code: 190, message: 'Error validating access token' } } }]);
  const r = await new CloudProvider(cfg, { fetch: f }).testConnection();
  assert.equal(r.ok, false); assert.match(r.detail, /access token/i);
});

test('error map: documented codes give clear outcomes', () => {
  assert.equal(classifyError({ code: 131047 }).kind, 'permanent');
  assert.match(classifyError({ code: 131047 }).label, /24-hour/);
  assert.equal(classifyError({ code: 131049 }).kind, 'permanent');
  assert.match(classifyError({ code: 131049 }).label, /Meta held/);
  assert.equal(classifyError({ code: 131050 }).optout, true);
  assert.equal(classifyError({ code: 132001 }).kind, 'permanent');
  assert.equal(classifyError({ code: 132015 }).templateProblem, true);
  assert.equal(classifyError({ code: 368 }).kind, 'account');
  assert.equal(classifyError({ code: 131056 }).kind, 'retry');
  assert.equal(classifyError({ code: 999999 }).kind, 'permanent');
  assert.equal(classifyError({ http: 500 }).kind, 'retry');
});

test('payloads: signature is HMAC-SHA256 of the raw body with the app secret', () => {
  const raw = JSON.stringify({ a: 1 });
  assert.equal(P.sign(raw, 'secret'), 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex'));
});

test('mock: delivers signed sent/delivered/read webhooks and can simulate a reply', async () => {
  const got = [];
  const m = new MockProvider({ appSecret: 's3', phoneNumberId: '1065', wabaId: '2020' }, { deliver: async (raw, headers) => got.push({ raw, headers }) });
  const r = await m.sendTemplate({ to: '+97339991000', name: 'lost_lead_price_v1', language: 'en', params: ['Ali'] });
  assert.equal(r.ok, true); assert.match(r.wamid, /^wamid\./);
  await m.flush();
  const statuses = got.map(g => JSON.parse(g.raw).entry[0].changes[0].value.statuses[0].status);
  assert.deepEqual(statuses, ['sent', 'delivered', 'read']);
  got.forEach(g => assert.equal(g.headers['x-hub-signature-256'], P.sign(g.raw, 's3')));
  m.simulateInbound({ from: '+97339991000', text: 'STOP', contextId: r.wamid });
  await m.flush();
  const msg = JSON.parse(got[3].raw).entry[0].changes[0].value;
  assert.equal(msg.messages[0].from, '97339991000');
  assert.equal(msg.messages[0].text.body, 'STOP');
  assert.equal(msg.contacts[0].wa_id, '97339991000');
});
test('mock: an unreachable number fails with 131026 by webhook, and injected API errors are returned', async () => {
  const got = [];
  const m = new MockProvider({ appSecret: 's', phoneNumberId: '1', wabaId: '2' }, { deliver: async raw => got.push(JSON.parse(raw)) });
  m.unreachable.add('+97339991001');
  await m.sendTemplate({ to: '+97339991001', name: 't', language: 'en', params: [] });
  await m.flush();
  const st = got.map(g => g.entry[0].changes[0].value.statuses[0]);
  assert.deepEqual(st.map(s => s.status), ['failed']);
  assert.equal(st[0].errors[0].code, 131026);
  m.failNext({ code: 130429 });
  const r = await m.sendTemplate({ to: '+97339991000', name: 't', language: 'en', params: [] });
  assert.equal(r.ok, false); assert.equal(r.error.kind, 'retry');
});
test('mock: template sync returns the catalogue in Meta shape', async () => {
  const m = new MockProvider({ appSecret: 's', mockApproveDrafts: false }, { deliver: async () => {} });
  const list = await m.listTemplates();
  assert.equal(list.find(t => t.name === 'lost_lead_price_v1').status, 'APPROVED');
  assert.equal(list.find(t => t.name === 'lost_lead_nudge_v1').status, 'PENDING');
});
test('dry-run: records, never sends, never produces webhooks', async () => {
  let fetched = false;
  const d = new DryRunProvider({}, { fetch: () => { fetched = true; } });
  const r = await d.sendTemplate({ to: '+97339991000', name: 't', language: 'en', params: ['a'] });
  assert.equal(r.ok, true); assert.match(r.wamid, /^dryrun\./);
  assert.equal(d.sent.length, 1); assert.equal(fetched, false);
});
