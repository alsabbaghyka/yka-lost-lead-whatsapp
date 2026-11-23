'use strict';
const { maskText, maskDeep } = require('./mask');

/** Record an action. user may be null for the system. Mobiles are masked before storage. */
function audit(db, user, action, target, detail, at) {
  db.prepare('INSERT INTO audit(at, user_id, user_email, action, target, detail) VALUES (?,?,?,?,?,?)').run(
    at || new Date().toISOString(), user ? user.id : null, user ? user.email : 'system', action,
    target == null ? null : maskText(String(target)), detail == null ? null : JSON.stringify(maskDeep(detail)));
}
function listAudit(db, { limit = 200, before } = {}) {
  return db.prepare(`SELECT * FROM audit ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(before ? [before, limit] : [limit])).map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
module.exports = { audit, listAudit };
