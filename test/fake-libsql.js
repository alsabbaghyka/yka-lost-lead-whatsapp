'use strict';
// A stand-in for @libsql/client's network client (execute / executeMultiple / transaction),
// backed by an in-memory node:sqlite database. Lets the whole suite run through the Turso
// adapter (LibsqlDb) without a network: LLE_TEST_ENGINE=libsql-fake.
const { DatabaseSync } = require('node:sqlite');

function result(db, sql, args) {
  const st = db.prepare(sql);
  const cols = st.columns().map(c => c.name);
  if (cols.length) {
    const rows = st.all(...args).map(o => cols.map(c => o[c]));
    return { columns: cols, rows, rowsAffected: 0, lastInsertRowid: undefined };
  }
  const r = st.run(...args);
  return { columns: [], rows: [], rowsAffected: Number(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) };
}

function fakeClient() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  let busy = Promise.resolve();          // one write transaction at a time, like Turso
  const exec = s => (typeof s === 'string' ? { sql: s, args: [] } : { sql: s.sql, args: s.args || [] });
  return {
    async execute(s) { await busy; const { sql, args } = exec(s); return result(db, sql, args); },
    async executeMultiple(sql) { await busy; db.exec(sql); },
    async transaction() {
      let release; const prev = busy; busy = new Promise(r => { release = r; }); await prev;
      db.exec('BEGIN IMMEDIATE');
      let open = true;
      const end = sql => { if (open) { db.exec(sql); open = false; release(); } };
      return {
        async execute(s) { const { sql, args } = exec(s); return result(db, sql, args); },
        async executeMultiple(sql) { db.exec(sql); },
        async commit() { end('COMMIT'); },
        async rollback() { end('ROLLBACK'); },
        close() { if (open) end('ROLLBACK'); }
      };
    },
    close() { db.close(); }
  };
}
module.exports = { fakeClient };
