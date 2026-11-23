'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const C = require('../src/clock');
const { maskMobile, maskText } = require('../src/mask');
const { audit } = require('../src/audit');
const Settings = require('../src/settings');
const { loadConfig } = require('../src/config');

test('migrations run once and are idempotent', async () => {
  const db = (await openDb(':memory:'));
  const v = (await db.prepare('SELECT MAX(version) v FROM schema_migrations').get()).v;
  assert.ok(v >= 1);
  await require('../src/db').migrate(db);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()).n, v);
  for (const t of ['users', 'customers', 'campaigns', 'enrollments', 'messages', 'webhook_events', 'optouts', 'suppressions', 'templates', 'dead_letters', 'audit', 'uploads'])
    assert.ok((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)), t);
});
test('opt-outs cannot be deleted at the database level', async () => {
  const db = (await openDb(':memory:'));
  (await db.prepare("INSERT INTO optouts(mobile, at, source) VALUES ('+97339990001', '2026-12-01T00:00:00Z', 'test')").run());
  await assert.rejects(async () => (await db.prepare('DELETE FROM optouts').run()), /opt-outs are permanent/);
});

test('Bahrain clock: Friday and quiet hours use Asia/Bahrain, not UTC', async () => {
  // 2026-12-03T22:30Z is Friday 01:30 in Bahrain (UTC+3)
  const t = Date.parse('2026-12-03T22:30:00Z');
  assert.equal(C.bahrainParts(t).weekday, 5);
  assert.equal(C.isFriday(t), true);
  assert.equal(C.bahrainDate(t), '2026-12-04');
  assert.equal(C.isFriday(Date.parse('2026-12-03T20:59:00Z')), false);
  assert.equal(C.inQuietHours(t, { start: '21:00', end: '09:00' }), true);
  assert.equal(C.inQuietHours(Date.parse('2026-12-03T07:00:00Z'), { start: '21:00', end: '09:00' }), false, '10:00 Bahrain');
  assert.equal(C.inQuietHours(Date.parse('2026-12-03T05:59:00Z'), { start: '21:00', end: '09:00' }), true, '08:59 Bahrain');
  assert.equal(C.inQuietHours(Date.parse('2026-12-03T12:00:00Z'), { start: '13:00', end: '14:00' }), false);
  assert.equal(C.inQuietHours(Date.parse('2026-12-03T10:30:00Z'), { start: '13:00', end: '14:00' }), true);
  assert.equal(C.dayIndex('2026-12-02', Date.parse('2026-12-04T10:00:00Z')), 2);
  assert.equal(C.bahrainInstant('2026-12-04', '10:00'), Date.parse('2026-12-04T07:00:00Z'));
});
test('fake clock advances', async () => {
  const f = C.fakeClock('2026-12-02T07:00:00Z');
  assert.equal(f.now(), Date.parse('2026-12-02T07:00:00Z'));
  f.advance(3600e3); assert.equal(new Date(f.now()).toISOString(), '2026-12-02T08:00:00.000Z');
  f.set('2026-12-05T00:00:00Z'); assert.equal(C.bahrainDate(f.now()), '2026-12-05');
});

test('mobiles are masked everywhere', async () => {
  assert.equal(maskMobile('+97339991234'), '+973****1234');
  assert.equal(maskMobile('39991234'), '+973****1234');
  assert.equal(maskText('sent to +97339991234 and 97366001122, ref 12'), 'sent to +973****1234 and +973****1122, ref 12');
});
test('the audit log never stores a raw mobile', async () => {
  const db = (await openDb(':memory:'));
  (await audit(db, { id: 1, email: 'a@x' }, 'optout.add', '+97339991234', { mobile: '+97339991234', note: 'customer 39991234 said stop' }));
  const row = (await db.prepare('SELECT * FROM audit').get());
  assert.doesNotMatch(JSON.stringify(row), /39991234/);
  assert.match(row.target, /\*\*\*\*1234/);
});
test('settings: safe defaults, typed values', async () => {
  const db = (await openDb(':memory:'));
  const s = (await Settings.all(db));
  assert.equal(s.go_live, false, 'test mode on by default');
  assert.equal(s.kill_switch, false);
  assert.equal(s.daily_cap, 200);
  assert.equal(s.friday_skip, true);
  assert.equal(s.quiet_start, '21:00');
  assert.equal(s.holdout_pct, 15);
  assert.equal(s.holdout_key, 2026);
  (await Settings.set(db, 'daily_cap', '50'));
  assert.equal((await Settings.get(db, 'daily_cap')), 50);
  await assert.rejects(async () => (await Settings.set(db, 'holdout_pct', 80)), /0 and 50/);
  await assert.rejects(async () => (await Settings.set(db, 'nope', 1)), /Unknown setting/);
});
test('config: defaults, required cloud values, version is configurable', async () => {
  const c = loadConfig({});
  assert.equal(c.provider, 'mock');
  assert.equal(c.graphVersion, 'v27.0');
  assert.throws(() => loadConfig({ WA_PROVIDER: 'cloud' }), /WA_ACCESS_TOKEN/);
  const cloud = loadConfig({ WA_PROVIDER: 'cloud', WA_ACCESS_TOKEN: 't', WA_PHONE_NUMBER_ID: '1', WA_WABA_ID: '2', WA_APP_SECRET: 's', WA_VERIFY_TOKEN: 'v', WA_GRAPH_VERSION: 'v26.0' });
  assert.equal(cloud.graphVersion, 'v26.0');
  assert.throws(() => loadConfig({ WA_GRAPH_VERSION: '27' }), /v27.0/);
});
test('SheetJS is the pinned 0.20.3 build', async () => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'xlsx.js'))).digest('hex');
  assert.equal(h, 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41');
});
