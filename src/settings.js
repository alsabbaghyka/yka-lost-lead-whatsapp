'use strict';
// Runtime settings an admin changes from the screen. Safe by default:
// test mode on (go_live false), kill switch off, a low daily cap.

const hhmm = v => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new Error('Use HH:MM (24h)'); return String(v); };
const int = (lo, hi) => v => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Must be a whole number between ${lo} and ${hi}`); return n; };
const bool = v => v === true || v === 'true' || v === 1 || v === '1';
const date = v => { if (v === '' || v == null) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error('Use yyyy-mm-dd'); return String(v); };

const DEFS = {
  go_live: { def: false, parse: bool, label: 'Go live (off = test mode: only allow-listed numbers receive anything)' },
  kill_switch: { def: false, parse: bool, label: 'Kill switch (on = nothing is sent)' },
  daily_cap: { def: 200, parse: int(0, 100000), label: 'Most business-initiated templates per Bahrain day' },
  max_per_second: { def: 10, parse: int(1, 80), label: 'Sending speed, messages per second' },
  friday_skip: { def: true, parse: bool, label: 'No automated sends on Fridays' },
  quiet_start: { def: '21:00', parse: hhmm, label: 'Quiet hours start (Bahrain)' },
  quiet_end: { def: '09:00', parse: hhmm, label: 'Quiet hours end (Bahrain)' },
  send_time: { def: '10:00', parse: hhmm, label: 'Time of day automated messages go out (Bahrain)' },
  holdout_pct: { def: 15, parse: v => { const n = Number(v); if (!(n >= 0 && n <= 50)) throw new Error('Holdout must be between 0 and 50'); return n; }, label: 'Holdout %' },
  holdout_key: { def: 2026, parse: int(0, 2 ** 31 - 1), label: 'Holdout key (never change mid-pilot)' },
  consent_from: { def: '2026-11-01', parse: date, label: 'Leads before this date get the permission request first' },
  recent_days: { def: 30, parse: int(0, 365), label: 'Skip anyone messaged in the last N days' },
  max_attempts: { def: 5, parse: int(1, 10), label: 'Send attempts before a message goes to dead letters' },
  template_language: { def: 'en', parse: v => { if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(String(v))) throw new Error('Language code like en or en_US'); return String(v); }, label: 'Template language code as submitted to Meta' }
};

async function get(db, key) {
  const d = DEFS[key]; if (!d) throw new Error('Unknown setting ' + key);
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? d.parse(JSON.parse(r.value)) : d.def;
}
async function set(db, key, value, userId) {
  const d = DEFS[key]; if (!d) throw Object.assign(new Error('Unknown setting ' + key), { status: 400 });
  let v;
  try { v = d.parse(value); } catch (e) { e.status = 400; e.message = `${key}: ${e.message}`; throw e; }
  await db.prepare('INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
    .run(key, JSON.stringify(v), new Date().toISOString(), userId || null);
  return v;
}
/** every setting in one query */
async function all(db) {
  const stored = new Map((await db.prepare('SELECT key, value FROM settings').all()).map(r => [r.key, r.value]));
  return Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, stored.has(k) ? d.parse(JSON.parse(stored.get(k))) : d.def]));
}
const describe = () => Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, { label: d.label, default: d.def }]));

module.exports = { get, set, all, describe, DEFS };
