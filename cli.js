'use strict';
// Admin commands. Run with the same environment as the server (or a .env file).
//   node cli.js create-admin --email it@example.com --name "IT Admin"   (password from ADMIN_PASSWORD or stdin)
//   node cli.js create-user  --email x@example.com --name "S. Kumar" --role sales
//   node cli.js migrate
//   node cli.js backup [--to backups/file.db]
//   node cli.js erase-customer --mobile 3999xxxx --by admin@example.com
//   node cli.js check
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig } = require('./src/config');
const { openDb, backup } = require('./src/db');
const { env, checkVendor } = require('./src/runtime');
const Auth = require('./src/auth');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = k => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : undefined; };

async function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.stdin.isTTY) process.stdout.write('Password (min 12 characters): ');
  const chunks = [];
  for await (const c of process.stdin) { chunks.push(c); if (String(c).includes('\n')) break; }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

(async () => {
  const cfg = loadConfig(env());
  if (cmd === 'check') {
    checkVendor();
    const db = openDb(cfg.dbPath);
    console.log(JSON.stringify({ provider: cfg.provider, graphVersion: cfg.graphVersion, db: cfg.dbPath, users: db.prepare('SELECT COUNT(*) n FROM users').get().n, sheetjs: 'ok' }, null, 2));
    return;
  }
  if (cmd === 'migrate') { openDb(cfg.dbPath); console.log('Database is up to date:', cfg.dbPath); return; }
  if (cmd === 'create-admin' || cmd === 'create-user') {
    const db = openDb(cfg.dbPath);
    const role = cmd === 'create-admin' ? 'admin' : opt('role');
    if (cmd === 'create-admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n && !args.includes('--another'))
      throw new Error('An admin already exists. Add more users from the Users screen, or pass --another.');
    const u = Auth.createUser(db, { email: opt('email'), name: opt('name') || opt('email'), role, password: await readPassword() });
    require('./src/audit').audit(db, null, 'user.create', u.email, { role: u.role, via: 'cli' });
    console.log(`Created ${u.role} ${u.email}`);
    return;
  }
  if (cmd === 'backup') {
    const db = openDb(cfg.dbPath);
    const dest = opt('to') || path.join(cfg.backupDir, `lost-lead-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    backup(db, dest);
    console.log('Backup written:', dest, `(${fs.statSync(dest).size} bytes). It holds customer data: store it encrypted.`);
    return;
  }
  if (cmd === 'erase-customer') {
    const db = openDb(cfg.dbPath);
    const by = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'admin' AND active = 1").get(opt('by') || '');
    if (!by) throw new Error('--by must be the email of an active admin (the erasure is recorded against them)');
    const { createContext } = require('./src/context');
    const ctx = createContext({ cfg: { ...cfg, provider: 'dry-run' }, db });
    console.log(JSON.stringify(require('./src/services/customers').erase(ctx, opt('mobile'), Auth.publicUser(by)), null, 2));
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = cmd ? 1 : 0;
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
