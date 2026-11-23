'use strict';
// The Vercel entry (api/index.js) behind a plain HTTP server, on a temporary SQLite file:
// original-path restore from the rewrite, first admin from the environment, cron auth,
// due work after responses, and refusal to run on Vercel without Turso.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lle-vercel-'));
const saved = { ...process.env };
let server, base, handler;
test.before(async () => {
  Object.assign(process.env, { WA_PROVIDER: 'mock', DB_PATH: path.join(dir, 'v.db'), CRON_SECRET: 'test-cron-secret',
    BOOTSTRAP_ADMIN_EMAIL: 'first@admin.test', BOOTSTRAP_ADMIN_PASSWORD: 'first admin password', BOOTSTRAP_ADMIN_NAME: 'First Admin' });
  delete process.env.VERCEL; delete process.env.TURSO_DATABASE_URL;
  handler = require('../api/index.js');
  server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close(); process.env = saved;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps the open SQLite file locked; the OS temp cleaner removes it */ }
});

test('a rewritten request reaches the original path', async () => {
  const r = await fetch(`${base}/api/index?__p=/healthz`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.provider, 'mock');
});
test('the first admin comes from BOOTSTRAP_ADMIN_* when there are no users, and can sign in', async () => {
  const r = await fetch(`${base}/api/index?__p=/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'first@admin.test', password: 'first admin password' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user.role, 'admin');
});
test('cron needs the CRON_SECRET bearer token, then runs due work', async () => {
  assert.equal((await fetch(`${base}/api/index?__p=/api/cron`)).status, 401);
  assert.equal((await fetch(`${base}/api/index?__p=/api/cron`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const r = await fetch(`${base}/api/index?__p=/api/cron`, { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.ok('outbox' in b && 'webhooks' in b);
});
test('query strings survive the rewrite', async () => {
  const r = await fetch(`${base}/api/index?__p=/webhook&hub.mode=subscribe&hub.verify_token=nope&hub.challenge=7`);
  assert.equal(r.status, 403, 'reached the webhook check with its own parameters');
});
test('on Vercel without Turso it refuses to start rather than keep data on a disk that disappears', async () => {
  const p = require.resolve('../api/index.js');
  delete require.cache[p];
  process.env.VERCEL = '1';
  const h = require(p);
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
  await h({ url: '/api/index?__p=/healthz', headers: {}, method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /TURSO_DATABASE_URL/);
  delete process.env.VERCEL; delete require.cache[p];
});
