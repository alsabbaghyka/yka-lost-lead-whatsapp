'use strict';
// First admin from the environment, and the one-time reset (BOOTSTRAP_ADMIN_RESET=1) used where
// there is no command line (Vercel) to fix the admin's email or password.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot } = require('../src/runtime');
const Auth = require('../src/auth');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lle-boot-'));
const base = { WA_PROVIDER: 'mock', DB_PATH: path.join(dir, 'b.db') };

test('first admin is created only while there are no users; the reset sets email and password once asked', async () => {
  const a = await boot({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'first@x.test', BOOTSTRAP_ADMIN_PASSWORD: 'first admin password' } });
  assert.ok(await Auth.login(a.db, 'first@x.test', 'first admin password'));
  await a.db.close();

  // without the reset flag a second boot changes nothing
  const b = await boot({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'new@x.test', BOOTSTRAP_ADMIN_PASSWORD: 'Short@pw9' } });
  await assert.rejects(Auth.login(b.db, 'new@x.test', 'Short@pw9'), /Wrong email or password/);
  await b.db.close();

  // with it, the named account becomes an active admin with that password (short passwords allowed only here)
  const c = await boot({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'new@x.test', BOOTSTRAP_ADMIN_PASSWORD: 'Short@pw9', BOOTSTRAP_ADMIN_RESET: '1' } });
  const s = await Auth.login(c.db, 'new@x.test', 'Short@pw9');
  assert.equal(s.user.role, 'admin');
  assert.ok((await c.db.prepare("SELECT 1 FROM audit WHERE action = 'user.reset_by_environment'").get()));
  // running the reset again (every cold start while the flag is on) does not duplicate the user
  await c.db.close();
  const d = await boot({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'new@x.test', BOOTSTRAP_ADMIN_PASSWORD: 'Short@pw9', BOOTSTRAP_ADMIN_RESET: '1' } });
  assert.equal((await d.db.prepare("SELECT COUNT(*) n FROM users WHERE email = 'new@x.test'").get()).n, 1);
  await d.db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
});
