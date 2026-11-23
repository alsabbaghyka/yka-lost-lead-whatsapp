'use strict';
// Users, roles, scrypt password hashes, server-side sessions and CSRF tokens.
const crypto = require('node:crypto');

const ROLES = ['admin', 'marketing', 'sales', 'viewer'];
/* what each role may do; admin may do everything */
const PERMS = {
  'view': ['admin', 'marketing', 'sales', 'viewer'],
  'import': ['admin', 'marketing'],
  'campaign.build': ['admin', 'marketing'],
  'campaign.approve': ['admin', 'marketing'],
  'campaign.control': ['admin', 'marketing'],
  'templates.sync': ['admin', 'marketing'],
  'suppression.edit': ['admin', 'marketing'],
  'optout.add': ['admin', 'marketing', 'sales'],
  'inbox.reply': ['admin', 'marketing', 'sales'],
  'results.edit': ['admin', 'marketing'],
  'kill.engage': ['admin', 'marketing'],
  'settings.edit': ['admin'],
  'users.manage': ['admin'],
  'customer.erase': ['admin'],
  'deadletter.retry': ['admin'],
  'audit.view': ['admin', 'marketing']
};
function can(user, perm) { return !!user && user.active !== 0 && (PERMS[perm] || []).includes(user.role); }
function must(user, perm) {
  if (!can(user, perm)) { const e = new Error(`Your role (${user ? user.role : 'none'}) is not allowed to do this (${perm})`); e.status = 403; throw e; }
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function checkPassword(pw) { if (String(pw || '').length < 12) { const e = new Error('Password must be at least 12 characters'); e.status = 400; throw e; } }

const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active });
function createUser(db, { email, name, role, password }) {
  if (!ROLES.includes(role)) { const e = new Error('Role must be one of ' + ROLES.join(', ')); e.status = 400; throw e; }
  if (!/^[^@\s]+@[^@\s]+$/.test(String(email || ''))) { const e = new Error('A valid email is required'); e.status = 400; throw e; }
  checkPassword(password);
  const u = db.prepare('INSERT INTO users(email, name, role, pw_hash, created_at) VALUES (?,?,?,?,?) RETURNING *')
    .get(String(email).trim(), String(name || email).trim(), role, hashPassword(password), new Date().toISOString());
  return publicUser(u);
}
const getUser = (db, id) => publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
const listUsers = db => db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
/* a dummy hash so an unknown email takes as long as a wrong password */
const DUMMY = hashPassword('dummy-password-for-timing');
const failures = new Map(); // email -> {n, until}
function login(db, email, password, { hours = 12, now = Date.now() } = {}) {
  const key = String(email || '').toLowerCase();
  const f = failures.get(key);
  if (f && f.until > now) { const e = new Error('Too many failed attempts. Try again in a few minutes.'); e.status = 429; throw e; }
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || ''));
  const ok = verifyPassword(password, u ? u.pw_hash : DUMMY) && u && u.active;
  if (!ok) {
    const n = (f ? f.n : 0) + 1;
    failures.set(key, { n, until: n >= 5 ? now + 5 * 60e3 : 0 });
    const e = new Error('Wrong email or password'); e.status = 401; throw e;
  }
  failures.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(id, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(sha(token), u.id, csrf, new Date(now).toISOString(), new Date(now + hours * 3600e3).toISOString());
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date(now).toISOString(), u.id);
  return { token, csrf, user: publicUser(u) };
}
function session(db, token, now = Date.now()) {
  if (!token) return null;
  const s = db.prepare('SELECT s.*, u.email, u.name, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(sha(token));
  if (!s || Date.parse(s.expires_at) < now || !s.active) return null;
  return { csrf: s.csrf, user: { id: s.user_id, email: s.email, name: s.name, role: s.role, active: s.active } };
}
function logout(db, token) { if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token)); }
const csrfOk = (sess, header) => !!(sess && header && sess.csrf.length === String(header).length && crypto.timingSafeEqual(Buffer.from(sess.csrf), Buffer.from(String(header))));

module.exports = { ROLES, PERMS, can, must, hashPassword, verifyPassword, createUser, getUser, listUsers, login, session, logout, csrfOk, publicUser, checkPassword };
