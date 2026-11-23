'use strict';
// The API over a real listening server: auth, cookies, CSRF, roles, uploads, webhook route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../src/runtime');
const Auth = require('../src/auth');
const P = require('../src/providers/payloads');

let sys, base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lle-http-'));
test.before(async () => {
  sys = await start({ env: { WA_PROVIDER: 'mock', DB_PATH: path.join(dir, 't.db'), PORT: '0', WORKER_INTERVAL_MS: '60000', SCHEDULER_INTERVAL_MS: '600000' } });
  base = `http://127.0.0.1:${sys.server.address().port}`;
  Auth.createUser(sys.ctx.db, { email: 'admin@t.local', name: 'Admin', role: 'admin', password: 'admin password 123' });
  Auth.createUser(sys.ctx.db, { email: 'view@t.local', name: 'Viewer', role: 'viewer', password: 'viewer password 123' });
});
test.after(async () => { await sys.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await r.json();
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, body, cookie, csrf: body.csrf, set: r.headers.get('set-cookie') };
}
const api = (s, method, url, body, extra = {}) => fetch(base + url, { method, headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });

test('health check needs no login and leaks nothing', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  const b = await r.json(); assert.equal(b.ok, true); assert.equal(b.provider, 'mock');
});
test('login sets an httpOnly SameSite cookie; wrong password is refused', async () => {
  const bad = await login('admin@t.local', 'wrong password 123');
  assert.equal(bad.r.status, 401);
  const s = await login('admin@t.local', 'admin password 123');
  assert.equal(s.r.status, 200);
  assert.match(s.set, /HttpOnly/); assert.match(s.set, /SameSite=Strict/);
  assert.equal(s.body.user.role, 'admin'); assert.ok(s.csrf);
});
test('the API needs a session', async () => {
  assert.equal((await fetch(base + '/api/me')).status, 401);
  assert.equal((await fetch(base + '/api/campaigns')).status, 401);
});
test('writes need the CSRF token and a same-origin Origin', async () => {
  const s = await login('admin@t.local', 'admin password 123');
  const noToken = await fetch(base + '/api/imports/sample', { method: 'POST', headers: { Cookie: s.cookie } });
  assert.equal(noToken.status, 403);
  const cross = await api(s, 'POST', '/api/imports/sample', null, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const ok = await api(s, 'POST', '/api/imports/sample');
  assert.equal(ok.status, 200);
  const b = await ok.json();
  assert.deepEqual([b.summary.total, b.summary.unique, b.summary.excluded, b.summary.holdout, b.summary.meta, b.summary.send], [160, 148, 31, 12, 11, 106]);
});
test('roles: a viewer can read but not build', async () => {
  const s = await login('view@t.local', 'viewer password 123');
  assert.equal((await api(s, 'GET', '/api/campaigns')).status, 200);
  assert.equal((await api(s, 'POST', '/api/imports/sample')).status, 403);
  assert.equal((await api(s, 'PUT', '/api/settings', { go_live: true })).status, 403);
  assert.equal((await api(s, 'POST', '/api/system/kill', { on: true })).status, 403);
});
test('upload a CSV, map columns, import', async () => {
  const s = await login('admin@t.local', 'admin password 123');
  const csv = 'Customer Name,Mobile No,Lost Reason,Remarks\nAli,39995001,Price too high,\nSara,39995002,Waiting for stock,white colour\n';
  const up = await fetch(base + '/api/uploads', { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'X-File-Name': 'lost.csv', 'Content-Type': 'application/octet-stream' }, body: csv });
  assert.equal(up.status, 200);
  const u = await up.json();
  assert.equal(u.map.mobile, 'Mobile No'); assert.equal(u.rowCount, 2);
  const imp = await (await api(s, 'POST', '/api/imports', { uploadId: u.uploadId, map: u.map })).json();
  assert.equal(imp.summary.send + imp.summary.holdout, 2);
  const again = await api(s, 'POST', '/api/imports', { uploadId: u.uploadId, map: u.map });
  assert.equal(again.status, 400, 'an upload is used once');
});
test('webhook route: verification and signature over the raw body', async () => {
  const cfg = sys.ctx.cfg;
  const v = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(cfg.verifyToken)}&hub.challenge=4242`);
  assert.equal(v.status, 200); assert.equal(await v.text(), '4242');
  assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
  const raw = JSON.stringify(P.statusPayload({ wamid: 'wamid.http1', status: 'sent', to: '+97339991000', timestamp: 1 }));
  assert.equal((await fetch(base + '/webhook', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': P.sign(raw, 'wrong') } })).status, 401);
  const ok = await fetch(base + '/webhook', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': P.sign(raw, cfg.appSecret) } });
  assert.equal(ok.status, 200);
});
test('static screens carry a strict CSP; path traversal is refused', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await r.text(), /Lost Lead WhatsApp/);
  const t = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(t.status, 200);
});
test('settings: only an admin turns go-live on, and it is audited', async () => {
  const s = await login('admin@t.local', 'admin password 123');
  const r = await api(s, 'PUT', '/api/settings', { go_live: true, daily_cap: 50 });
  assert.equal(r.status, 200);
  const audit = await (await api(s, 'GET', '/api/audit')).json();
  assert.ok(audit.some(a => a.action === 'settings.update' && a.detail.go_live));
  assert.equal((await api(s, 'PUT', '/api/settings', { holdout_pct: 90 })).status, 400);
  await api(s, 'PUT', '/api/settings', { go_live: false });
});

test('Origin: "null" and other sites are refused; the reverse proxy\'s forwarded host is accepted', async () => {
  const s = await login('admin@t.local', 'admin password 123');
  assert.equal((await api(s, 'POST', '/api/system/kill', { on: false }, { Origin: 'null' })).status, 403);
  assert.equal((await api(s, 'POST', '/api/system/kill', { on: false }, { Origin: 'https://lostlead.example', 'X-Forwarded-Host': 'evil.example' })).status, 403);
  assert.equal((await api(s, 'POST', '/api/system/kill', { on: false }, { Origin: 'https://lostlead.example', 'X-Forwarded-Host': 'lostlead.example' })).status, 200);
});
