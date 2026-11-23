'use strict';
// One async database interface, two engines with the same SQL:
//   - SQLite file (node:sqlite) for Windows / Docker / tests
//   - Turso (hosted libSQL, i.e. SQLite) over HTTPS for Vercel, where there is no lasting disk
// Code uses:  await db.prepare(sql).get(...args) / .all(...) / .run(...)  and  await tx(db, async () => …)
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const plain = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v);

/* ---------- SQLite (node:sqlite) ---------- */
class SqliteDb {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.kind = 'sqlite';
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.als = new AsyncLocalStorage();
    this.lock = Promise.resolve();   // resolves when the open transaction ends
    this.inTx = false;
    this.depth = 0;
  }
  /* outside a transaction, wait until no other caller's transaction is open (one connection) */
  /* the check is repeated after every wait, and the query runs synchronously right after it, so it
     can never land inside a transaction that began while it was waiting */
  async gate() { while (this.inTx && !this.als.getStore()) await this.lock; }
  prepare(sql) {
    return {
      get: async (...a) => { await this.gate(); const r = this.raw.prepare(sql).get(...a.map(plain)); return r ? { ...r } : undefined; },
      all: async (...a) => { await this.gate(); return this.raw.prepare(sql).all(...a.map(plain)).map(r => ({ ...r })); },
      run: async (...a) => { await this.gate(); const r = this.raw.prepare(sql).run(...a.map(plain)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
    };
  }
  async exec(sql) { await this.gate(); this.raw.exec(sql); }
  async transaction(fn) {
    if (this.als.getStore()) {                   // nested: a savepoint inside the open transaction
      const sp = 'sp' + (++this.depth);
      this.raw.exec(`SAVEPOINT ${sp}`);
      try { const r = await fn(); this.raw.exec(`RELEASE ${sp}`); return r; }
      catch (e) { this.raw.exec(`ROLLBACK TO ${sp}`); this.raw.exec(`RELEASE ${sp}`); throw e; }
    }
    let release; const prev = this.lock;
    this.lock = new Promise(r => { release = r; });
    await prev;
    try {
      this.inTx = true;
      this.raw.exec('BEGIN IMMEDIATE');
      return await this.als.run(true, async () => {
        try { const r = await fn(); this.raw.exec('COMMIT'); return r; }
        catch (e) { this.raw.exec('ROLLBACK'); throw e; }
      });
    } finally { this.inTx = false; release(); }
  }
  async backup(dest) {
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    if (fs.existsSync(dest)) throw new Error('Backup file already exists: ' + dest);
    this.raw.prepare('VACUUM INTO ?').run(dest);
    return dest;
  }
  async close() { this.raw.close(); }
}

/* ---------- Turso / libSQL over HTTPS ---------- */
class LibsqlDb {
  constructor(url, authToken) {
    const { createClient } = require('@libsql/client/web');   // HTTP-only build: pure JS, fine on Vercel
    this.kind = 'libsql';
    this.client = createClient({ url, authToken, intMode: 'number' });
    this.als = new AsyncLocalStorage();
    this.depth = 0;
  }
  async execute(sql, args) {
    const t = this.als.getStore();
    const rs = await (t || this.client).execute({ sql, args: args.map(plain) });
    const rows = rs.rows.map(row => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));
    return { rows, changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? 0 : Number(rs.lastInsertRowid) };
  }
  prepare(sql) {
    return {
      get: async (...a) => (await this.execute(sql, a)).rows[0],
      all: async (...a) => (await this.execute(sql, a)).rows,
      run: async (...a) => { const r = await this.execute(sql, a); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; }
    };
  }
  async exec(sql) {
    const t = this.als.getStore();
    if (t) await t.executeMultiple(sql); else await this.client.executeMultiple(sql);
  }
  async transaction(fn) {
    const open = this.als.getStore();
    if (open) {
      const sp = 'sp' + (++this.depth);
      await open.execute(`SAVEPOINT ${sp}`);
      try { const r = await fn(); await open.execute(`RELEASE ${sp}`); return r; }
      catch (e) { await open.execute(`ROLLBACK TO ${sp}`); await open.execute(`RELEASE ${sp}`); throw e; }
    }
    const t = await this.client.transaction('write');
    try {
      const r = await this.als.run(t, fn);
      await t.commit();
      return r;
    } catch (e) { try { await t.rollback(); } catch { /* already closed */ } throw e; }
    finally { t.close(); }
  }
  async backup() { throw new Error('This database is hosted on Turso: use Turso point-in-time restore / its dump instead of a file backup.'); }
  async close() { this.client.close(); }
}

async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((await db.prepare('SELECT version FROM schema_migrations').all()).map(r => r.version));
  const files = fs.readdirSync(MIGRATIONS).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const v = parseInt(f, 10);
    if (done.has(v)) continue;
    await db.transaction(async () => {
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      await db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)').run(v, f, new Date().toISOString());
    });
  }
}

/** Open (and migrate) the database: Turso when a URL is given, otherwise a SQLite file. */
async function openDb(target, opts = {}) {
  const db = opts.tursoUrl ? new LibsqlDb(opts.tursoUrl, opts.tursoToken) : new SqliteDb(target);
  await migrate(db);
  return db;
}

const tx = (db, fn) => db.transaction(fn);
const backup = (db, dest) => db.backup(dest);

module.exports = { openDb, migrate, tx, backup, SqliteDb, LibsqlDb };
