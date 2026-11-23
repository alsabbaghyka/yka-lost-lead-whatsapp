'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  const files = fs.readdirSync(MIGRATIONS).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const v = parseInt(f, 10);
    if (done.has(v)) continue;
    tx(db, () => {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)').run(v, f, new Date().toISOString());
    });
  }
}

/** Run fn inside a transaction (nesting-safe via savepoints). */
let depth = 0;
function tx(db, fn) {
  const sp = 'sp' + (++depth);
  db.exec(`SAVEPOINT ${sp}`);
  try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; }
  catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e; }
  finally { depth--; }
}

/** Consistent online copy of the database (VACUUM INTO). */
function backup(db, dest) {
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  if (fs.existsSync(dest)) throw new Error('Backup file already exists: ' + dest);
  db.prepare('VACUUM INTO ?').run(dest);
  return dest;
}

module.exports = { openDb, migrate, tx, backup };
