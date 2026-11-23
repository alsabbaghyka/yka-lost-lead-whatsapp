'use strict';
// Meta webhook endpoint. GET answers the verification challenge. POST checks
// X-Hub-Signature-256 over the raw body, splits the notification into one row
// per message / status / template event (INSERT OR IGNORE on a stable key, so
// Meta's retries are harmless), returns 200, and is processed afterwards from
// that table — a crash between the two loses nothing.
const crypto = require('node:crypto');
const { audit } = require('./audit');
const { log } = require('./mask');

function verifyChallenge(cfg, q) {
  const ok = q['hub.mode'] === 'subscribe' && cfg.verifyToken && typeof q['hub.verify_token'] === 'string' &&
    q['hub.verify_token'].length === cfg.verifyToken.length &&
    crypto.timingSafeEqual(Buffer.from(q['hub.verify_token']), Buffer.from(cfg.verifyToken));
  return ok ? { status: 200, body: String(q['hub.challenge'] || '') } : { status: 403, body: 'Forbidden' };
}

function verifySignature(secret, raw, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const got = header.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(got.toLowerCase(), 'hex'));
}

const insert = (db, key, kind, payload, at) =>
  db.prepare('INSERT OR IGNORE INTO webhook_events(event_key, kind, payload, received_at) VALUES (?,?,?,?)').run(key, kind, JSON.stringify(payload), at).changes;

/** @returns {{status:number, stored:number}} */
async function receive(ctx, raw, headers = {}) {
  const sig = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'];
  if (!verifySignature(ctx.cfg.appSecret, raw, sig)) return { status: 401, stored: 0 };
  let body;
  try { body = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); }
  catch { audit(ctx.db, null, 'webhook.malformed', null, { bytes: raw.length }); return { status: 200, stored: 0 }; }
  const at = ctx.nowIso();
  let stored = 0;
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'messages') {
        for (const m of v.messages || []) stored += insert(ctx.db, 'msg:' + m.id, 'message', { message: m, contacts: v.contacts || [], metadata: v.metadata || {} }, at);
        for (const s of v.statuses || []) stored += insert(ctx.db, `st:${s.id}:${s.status}`, 'status', { status: s, metadata: v.metadata || {} }, at);
        for (const e of v.errors || []) stored += insert(ctx.db, 'err:' + crypto.createHash('sha256').update(JSON.stringify(e) + entry.id).digest('hex').slice(0, 32), 'error', { error: e, metadata: v.metadata || {} }, at);
      } else if (ch.field === 'message_template_status_update') {
        stored += insert(ctx.db, `tpl:${v.message_template_id}:${v.message_template_language}:${v.event}:${entry.time || ''}`, 'template', v, at);
      } else {
        stored += insert(ctx.db, 'other:' + crypto.createHash('sha256').update(JSON.stringify(ch)).digest('hex').slice(0, 32), 'unknown', ch, at);
      }
    }
  }
  return { status: 200, stored };
}

const MAX_EVENT_ATTEMPTS = 5;
/** Process stored events in arrival order. Returns how many were handled. */
async function processPending(ctx, limit = 200) {
  const conversation = require('./services/conversation');
  const rows = ctx.db.prepare('SELECT * FROM webhook_events WHERE processed_at IS NULL ORDER BY id LIMIT ?').all(limit);
  for (const r of rows) {
    try {
      const note = conversation.handleEvent(ctx, r.kind, JSON.parse(r.payload));
      ctx.db.prepare('UPDATE webhook_events SET processed_at = ?, attempts = attempts + 1, error = ? WHERE id = ?').run(ctx.nowIso(), note || null, r.id);
    } catch (e) {
      const attempts = r.attempts + 1;
      ctx.db.prepare('UPDATE webhook_events SET attempts = ?, error = ?, processed_at = ? WHERE id = ?')
        .run(attempts, String(e && e.stack || e).slice(0, 2000), attempts >= MAX_EVENT_ATTEMPTS ? ctx.nowIso() : null, r.id);
      log('webhook event failed', { id: r.id, kind: r.kind, error: String(e && e.message || e) });
      if (attempts >= MAX_EVENT_ATTEMPTS) audit(ctx.db, null, 'webhook.poison', String(r.id), { kind: r.kind, error: String(e && e.message || e) });
    }
  }
  return rows.length;
}

module.exports = { verifyChallenge, verifySignature, receive, processPending };
