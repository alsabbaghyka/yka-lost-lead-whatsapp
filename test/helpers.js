'use strict';
// A whole system in memory: SQLite :memory:, fake Bahrain clock, mock provider
// whose signed webhooks go through the real ingest path.
const { openDb, LibsqlDb, migrate } = require('../src/db');

/** The test database: SQLite, or the Turso adapter over a local stand-in (LLE_TEST_ENGINE=libsql-fake). */
async function testDb() {
  if (process.env.LLE_TEST_ENGINE !== 'libsql-fake') return openDb(':memory:');
  const db = new LibsqlDb('http://fake.invalid', 'unused');
  db.client = require('./fake-libsql').fakeClient();
  await migrate(db);
  return db;
}
const { loadConfig } = require('../src/config');
const { fakeClock } = require('../src/clock');
const { createContext } = require('../src/context');
const Auth = require('../src/auth');
const Settings = require('../src/settings');

async function makeSystem({ now = '2026-12-02T07:00:00Z', env = {}, provider } = {}) {
  const cfg = loadConfig({ WA_PROVIDER: 'mock', DB_PATH: ':memory:', ...env });
  const db = await testDb();
  const clock = fakeClock(now);
  const ctx = createContext({ cfg, db, clock, provider });
  const users = {
    admin: (await Auth.createUser(db, { email: 'admin@test.local', name: 'Admin One', role: 'admin', password: 'correct horse battery 1' })),
    m1: (await Auth.createUser(db, { email: 'm1@test.local', name: 'Marketing One', role: 'marketing', password: 'correct horse battery 2' })),
    m2: (await Auth.createUser(db, { email: 'm2@test.local', name: 'Marketing Two', role: 'marketing', password: 'correct horse battery 3' })),
    sales: (await Auth.createUser(db, { email: 'kumar@test.local', name: 'S. Kumar', role: 'sales', password: 'correct horse battery 4' })),
    viewer: (await Auth.createUser(db, { email: 'v@test.local', name: 'Viewer', role: 'viewer', password: 'correct horse battery 5' }))
  };
  /** deliver mock webhooks and process them */
  ctx.pump = async () => { for (let i = 0; i < 5; i++) { if (ctx.provider.flush) await ctx.provider.flush(); await ctx.processWebhooks(); } };
  return { ctx, db, clock, cfg, users, Settings };
}
const H = 3600e3, D = 864e5;
module.exports = { makeSystem, testDb, H, D };
