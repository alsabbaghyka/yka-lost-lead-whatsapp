'use strict';
// HTTP: static screens, the REST API (docs/openapi.yaml) and the Meta webhook.
// Sessions are httpOnly cookies; every state-changing API call needs the
// session's CSRF token in X-CSRF-Token and a same-origin Origin (when sent).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Auth = require('../auth');
const Settings = require('../settings');
const W = require('../webhook');
const { readSpreadsheet } = require('../spreadsheet');
const { detect, detectByContent, FIELDS, sampleRows } = require('../rules/engine');
const { cleanMobile } = require('../rules/mobile');
const Campaigns = require('../services/campaigns');
const Templates = require('../services/templates');
const Opt = require('../services/optouts');
const Inbox = require('../services/inbox');
const Customers = require('../services/customers');
const Results = require('../services/results');
const Exports = require('../services/exports');
const Sender = require('../services/sender');
const { audit, listAudit } = require('../audit');
const { log } = require('../mask');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.yaml': 'text/yaml; charset=utf-8' };
const COOKIE = 'lle_sid';
const LIMIT_JSON = 1 << 20, LIMIT_FILE = 26 << 20, LIMIT_WEBHOOK = 5 << 20;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body), isStr = typeof body === 'string';
  const payload = isBuf || isStr ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': isBuf || isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpError(413, 'Request too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const csvReply = (res, name, text) => send(res, 200, '﻿' + text, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"` });

/* uploaded files waiting for a decision (column mapping, which list): per user, used once, 30 minutes.
   Stored in the database so the next request may reach any instance. Dates survive as ISO strings. */
const ISO_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
async function putUpload(ctx, user, data) {
  const id = crypto.randomBytes(12).toString('base64url');
  const now = ctx.clock.now();
  await ctx.db.prepare('DELETE FROM uploads WHERE expires_at < ?').run(new Date(now).toISOString());
  await ctx.db.prepare('INSERT INTO uploads(id, user_id, file_name, data, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(id, user.id, data.fileName, JSON.stringify({ rows: data.rows, names: data.names, headerless: data.headerless }), new Date(now).toISOString(), new Date(now + 30 * 60e3).toISOString());
  return id;
}
/** Run fn with the upload; it is deleted only when fn succeeds, so a mapping mistake can be corrected. */
async function useUpload(ctx, user, id, fn) {
  const row = await ctx.db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ? AND expires_at >= ?').get(String(id || ''), user.id, new Date(ctx.clock.now()).toISOString());
  if (!row) throw httpError(400, 'That upload has expired or was already used. Choose the file again.');
  const data = JSON.parse(row.data, (k, v) => (typeof v === 'string' && ISO_TS.test(v) ? new Date(v) : v));
  const out = await fn({ fileName: row.file_name, ...data });
  await ctx.db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
  return out;
}

function createApp(ctx) {
  const routes = [];
  const r = (method, pattern, opts, fn) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, fn, ...opts });
  };
  const userFrom = req => Auth.session(ctx.db, cookies(req)[COOKIE], ctx.clock.now());
  /* Origin (when the browser sends one) must be this site: the Host we were called with, the host a
     reverse proxy says it forwarded (X-Forwarded-Host), or PUBLIC_URL. "null" and garbage are refused. */
  const publicHost = ctx.cfg.publicUrl ? (() => { try { return new URL(ctx.cfg.publicUrl).host; } catch { return null; } })() : null;
  const sameOrigin = req => {
    const origin = req.headers.origin;
    if (!origin) return true;
    let host; try { host = new URL(origin).host; } catch { return false; }
    if (!host) return false;
    const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    return host === req.headers.host || (fwd && host === fwd) || (publicHost && host === publicHost);
  };
  const num = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Bad id'); return n; };

  /* ---------- public ---------- */
  r('GET', '/healthz', { auth: false }, async () => {
    const backlog = (await ctx.db.prepare('SELECT COUNT(*) n FROM webhook_events WHERE processed_at IS NULL').get()).n;
    return { ok: true, provider: ctx.provider.name, database: ctx.db.kind, webhookBacklog: backlog, halted: !!(await Sender.halted(ctx)) };
  });
  r('POST', '/api/login', { auth: false, csrf: false }, async ({ body, res }) => {
    const out = await Auth.login(ctx.db, body.email, body.password, { hours: ctx.cfg.sessionHours, now: ctx.clock.now() });
    await audit(ctx.db, out.user, 'login', null);
    res.setHeader('Set-Cookie', `${COOKIE}=${out.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ctx.cfg.sessionHours * 3600}${ctx.cfg.cookieSecure ? '; Secure' : ''}`);
    return { user: out.user, csrf: out.csrf };
  });

  /* ---------- session ---------- */
  r('POST', '/api/logout', { perm: 'view' }, async ({ req, res, user }) => {
    await Auth.logout(ctx.db, cookies(req)[COOKIE]); await audit(ctx.db, user, 'logout', null);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });
  r('GET', '/api/me', { perm: 'view' }, async ({ user, sess }) => {
    const s = await Settings.all(ctx.db);
    return { user, csrf: sess.csrf, provider: ctx.provider.name, goLive: s.go_live, killSwitch: s.kill_switch, halted: await Sender.halted(ctx),
      perms: Object.keys(Auth.PERMS).filter(p => Auth.can(user, p)), demo: !!ctx.cfg.demo };
  });
  r('GET', '/api/dashboard', { perm: 'view' }, async ({ user }) => {
    const s = await Settings.all(ctx.db), now = ctx.clock.now();
    const q = async sql => (await ctx.db.prepare(sql).get()).n;
    const [halted, sentToday, campaigns, queued, inbox, optouts, deadLetters, webhookBacklog, approvedTemplates, lastSync, pendingApproval, recent] = await Promise.all([
      Sender.halted(ctx), Sender.templatesSentToday(ctx, now),
      ctx.db.prepare('SELECT status, COUNT(*) n FROM campaigns GROUP BY status').all(),
      q("SELECT COUNT(*) n FROM messages WHERE status = 'queued'"),
      Inbox.list(ctx, user),
      q('SELECT COUNT(*) n FROM optouts'),
      q('SELECT COUNT(*) n FROM dead_letters WHERE resolved_at IS NULL'),
      q('SELECT COUNT(*) n FROM webhook_events WHERE processed_at IS NULL'),
      q("SELECT COUNT(*) n FROM templates WHERE status = 'APPROVED'"),
      ctx.db.prepare('SELECT MAX(synced_at) t FROM templates').get(),
      ctx.db.prepare("SELECT id, name, created_by FROM campaigns WHERE status = 'pending_approval'").all(),
      ctx.db.prepare('SELECT dir, kind, status, outcome, created_at, mobile FROM messages ORDER BY id DESC LIMIT 12').all()
    ]);
    return { goLive: s.go_live, killSwitch: s.kill_switch, halted, provider: ctx.provider.name, sentToday, dailyCap: s.daily_cap,
      campaigns: Object.fromEntries(campaigns.map(x => [x.status, x.n])), queued, inbox: inbox.length, optouts, deadLetters, webhookBacklog,
      approvedTemplates, lastSync: (lastSync || {}).t || null, pendingApproval, recent };
  });

  /* ---------- uploads + imports ---------- */
  r('POST', '/api/uploads', { perm: 'view', raw: LIMIT_FILE }, async ({ req, raw, user }) => {
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload'));
    const sheet = readSpreadsheet(raw, fileName);
    if (!sheet.rows.length) throw httpError(400, 'No rows found in that file');
    const map = sheet.headerless ? detectByContent(sheet.rows, sheet.names) : detect(sheet.names);
    const id = await putUpload(ctx, user, { fileName, ...sheet });
    return { uploadId: id, fileName, rowCount: sheet.rows.length, headers: sheet.names, headerless: sheet.headerless, map, fields: FIELDS.map(f => ({ key: f.key, label: f.label, req: !!f.req })), sample: sheet.rows.slice(0, 5) };
  });
  r('POST', '/api/imports', { perm: 'import' }, async ({ body, user }) => {
    return useUpload(ctx, user, body.uploadId, u => Campaigns.createImport(ctx, { fileName: u.fileName, rows: u.rows, map: body.map, user, headerless: u.headerless }));
  });
  r('POST', '/api/imports/sample', { perm: 'import' }, ({ user }) => Campaigns.createImport(ctx, { fileName: 'Sample data (fictional)', rows: sampleRows(), user }));
  r('GET', '/api/imports', { perm: 'view' }, () => Campaigns.listImports(ctx.db));
  r('GET', '/api/imports/:id', { perm: 'view' }, ({ p }) => Campaigns.preview(ctx, num(p.id)));
  r('GET', '/api/imports/:id/export/:kind', { perm: 'view', csv: true }, async ({ p, res }) => csvReply(res, `${p.kind}-import-${p.id}.csv`, await Exports.importCsv(ctx, num(p.id), p.kind)));

  /* ---------- campaigns ---------- */
  r('GET', '/api/campaigns', { perm: 'view' }, () => Campaigns.list(ctx.db));
  r('POST', '/api/campaigns', { perm: 'campaign.build' }, ({ body, user }) => Campaigns.createCampaign(ctx, { importId: num(body.importId), name: body.name, startDate: body.startDate, user }));
  r('GET', '/api/campaigns/:id', { perm: 'view' }, ({ p }) => Campaigns.get(ctx, num(p.id)));
  for (const action of ['submit', 'approve', 'reject', 'start', 'pause', 'resume', 'complete', 'cancel'])
    r('POST', `/api/campaigns/:id/${action}`, { perm: 'view' }, async ({ p, user, body }) => { const out = await Campaigns[action](ctx, num(p.id), user, body.note); return { ok: true, ...(out || {}) }; });
  r('GET', '/api/campaigns/:id/results', { perm: 'view' }, ({ p, query }) => Results.compute(ctx, num(p.id), { windowDays: query.window }));
  r('GET', '/api/campaigns/:id/export/crm', { perm: 'view', csv: true }, async ({ p, res }) => csvReply(res, `crm-writeback-campaign-${p.id}.csv`, await Exports.crmWriteback(ctx, num(p.id))));

  /* ---------- templates ---------- */
  r('GET', '/api/templates', { perm: 'view' }, async () => ({ templates: await Templates.list(ctx.db, await Settings.get(ctx.db, 'template_language')), provider: ctx.provider.name }));
  r('POST', '/api/templates/sync', { perm: 'templates.sync' }, ({ user }) => Templates.sync(ctx, user));
  r('GET', '/api/templates/export', { perm: 'view', csv: true }, ({ res }) => csvReply(res, 'whatsapp-templates-to-submit.csv', Exports.templatesCsv()));

  /* ---------- inbox ---------- */
  r('GET', '/api/inbox', { perm: 'view' }, ({ user }) => Inbox.list(ctx, user));
  r('POST', '/api/inbox/:id/reply', { perm: 'inbox.reply' }, async ({ p, body, user }) => ({ messageId: await Inbox.reply(ctx, num(p.id), body.body, user) }));
  r('POST', '/api/inbox/:id/resolve', { perm: 'inbox.reply' }, async ({ p, body, user }) => { await Inbox.resolve(ctx, num(p.id), user, body.note); return { ok: true }; });
  r('POST', '/api/inbox/:id/assign', { perm: 'campaign.control' }, async ({ p, body, user }) => { await Inbox.assign(ctx, num(p.id), body.userId ? num(body.userId) : null, user); return { ok: true }; });

  /* ---------- customers ---------- */
  r('GET', '/api/customers', { perm: 'view' }, ({ query }) => Customers.search(ctx, query.q));
  r('GET', '/api/customers/:mobile', { perm: 'view' }, ({ p }) => Customers.timeline(ctx, decodeURIComponent(p.mobile)));
  r('POST', '/api/customers/:mobile/erase', { perm: 'customer.erase' }, ({ p, body, user }) => {
    const m = cleanMobile(decodeURIComponent(p.mobile));
    if (!m || cleanMobile(body.confirm) !== m) throw httpError(400, 'Type the mobile again to confirm the erasure');
    return Customers.erase(ctx, m, user);
  });

  /* ---------- opt-outs, lists, allow-list ---------- */
  r('GET', '/api/optouts', { perm: 'view' }, () => Opt.listOptouts(ctx.db));
  r('POST', '/api/optouts', { perm: 'optout.add' }, ({ body, user }) => Opt.addOptout(ctx, body.mobile, { source: 'manual', text: body.note, user }));
  r('POST', '/api/optouts/import', { perm: 'suppression.edit' }, async ({ body, user }) => { return useUpload(ctx, user, body.uploadId, u => Opt.importOptoutFile(ctx, { rows: u.rows, headers: u.names, fileName: u.fileName, user })); });
  r('GET', '/api/optouts/export', { perm: 'view', csv: true }, async ({ res }) => csvReply(res, 'opt-out-list.csv', await Exports.optoutsCsv(ctx)));
  r('GET', '/api/suppressions', { perm: 'view' }, ({ query }) => Opt.listSuppressions(ctx.db, query.list));
  r('POST', '/api/suppressions', { perm: 'suppression.edit' }, ({ body, user }) => Opt.addSuppressions(ctx, body.list, [].concat(body.mobiles || []), user));
  r('POST', '/api/suppressions/import', { perm: 'suppression.edit' }, async ({ body, user }) => { return useUpload(ctx, user, body.uploadId, u => Opt.suppressionsFromRows(ctx, body.list, u.rows, u.fileName, user)); });
  r('DELETE', '/api/suppressions/:list/:mobile', { perm: 'suppression.edit' }, async ({ p, user }) => ({ removed: await Opt.removeSuppression(ctx, p.list, decodeURIComponent(p.mobile), user) }));
  r('GET', '/api/allowlist', { perm: 'view' }, () => Opt.listAllowlist(ctx.db));
  r('POST', '/api/allowlist', { perm: 'settings.edit' }, async ({ body, user }) => ({ mobile: await Opt.allowlistAdd(ctx, body.mobile, body.note, user) }));
  r('DELETE', '/api/allowlist/:mobile', { perm: 'settings.edit' }, async ({ p, user }) => { await Opt.allowlistRemove(ctx, decodeURIComponent(p.mobile), user); return { ok: true }; });

  /* ---------- results ---------- */
  r('POST', '/api/outcomes/import', { perm: 'results.edit' }, async ({ body, user }) => { return useUpload(ctx, user, body.uploadId, u => Results.importOutcomes(ctx, { fileName: u.fileName, rows: u.rows, user })); });
  r('GET', '/api/outcomes', { perm: 'view' }, () => Results.listOutcomeFiles(ctx.db));
  r('DELETE', '/api/outcomes/:batch', { perm: 'results.edit' }, async ({ p, user }) => ({ removed: await Results.clearOutcomes(ctx, p.batch, user) }));

  /* ---------- settings + system ---------- */
  r('GET', '/api/settings', { perm: 'view' }, async () => ({ values: await Settings.all(ctx.db), describe: Settings.describe(), provider: ctx.provider.name, graphVersion: ctx.cfg.graphVersion,
    phoneNumberId: ctx.cfg.phoneNumberId || null, wabaId: ctx.cfg.wabaId || null, webhookPath: '/webhook', publicUrl: ctx.cfg.publicUrl || null }));
  r('PUT', '/api/settings', { perm: 'settings.edit' }, async ({ body, user }) => {
    const changed = {};
    for (const [k, v] of Object.entries(body || {})) { const before = await Settings.get(ctx.db, k); const after = await Settings.set(ctx.db, k, v, user.id); if (before !== after) changed[k] = { from: before, to: after }; }
    if (Object.keys(changed).length) await audit(ctx.db, user, 'settings.update', null, changed);
    return Settings.all(ctx.db);
  });
  r('POST', '/api/system/kill', { perm: 'kill.engage' }, async ({ body, user }) => {
    const on = !!body.on;
    if (!on && user.role !== 'admin') throw httpError(403, 'Only an admin can release the kill switch');
    await Settings.set(ctx.db, 'kill_switch', on, user.id);
    await audit(ctx.db, user, on ? 'kill_switch.on' : 'kill_switch.off', null);
    return { killSwitch: on };
  });
  r('POST', '/api/system/resume-sending', { perm: 'deadletter.retry' }, async ({ user }) => { await Sender.resume(ctx, user); return { ok: true }; });
  r('POST', '/api/settings/test-connection', { perm: 'settings.edit' }, async ({ user }) => { const out = await ctx.provider.testConnection(); await audit(ctx.db, user, 'connection.test', ctx.provider.name, { ok: out.ok, detail: out.detail }); return out; });
  r('GET', '/api/dead-letters', { perm: 'view' }, () => Sender.listDeadLetters(ctx.db));
  r('POST', '/api/dead-letters/:id/retry', { perm: 'deadletter.retry' }, async ({ p, user }) => { await Sender.retryDeadLetter(ctx, num(p.id), user); return { ok: true }; });
  r('POST', '/api/dead-letters/:id/discard', { perm: 'deadletter.retry' }, async ({ p, user }) => { await Sender.discardDeadLetter(ctx, num(p.id), user); return { ok: true }; });
  r('GET', '/api/audit', { perm: 'audit.view' }, ({ query }) => listAudit(ctx.db, { limit: Math.min(1000, Number(query.limit) || 200), before: query.before ? Number(query.before) : undefined }));
  /* run due work now (scheduler, outbox, webhooks) — what the background workers do on a server */
  r('POST', '/api/system/run-due', { perm: 'campaign.control' }, () => ctx.runDue ? ctx.runDue({ force: true }) : { ok: true });

  /* ---------- users ---------- */
  r('GET', '/api/users', { perm: 'view' }, () => Auth.listUsers(ctx.db));
  r('POST', '/api/users', { perm: 'users.manage' }, async ({ body, user }) => { const u = await Auth.createUser(ctx.db, body); await audit(ctx.db, user, 'user.create', u.email, { role: u.role }); return u; });
  r('PATCH', '/api/users/:id', { perm: 'users.manage' }, async ({ p, body, user }) => {
    const id = num(p.id);
    if (body.role) { if (!Auth.ROLES.includes(body.role)) throw httpError(400, 'Unknown role'); await ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id); }
    if (body.active != null) { if (id === user.id && !body.active) throw httpError(400, 'You cannot deactivate yourself'); await ctx.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id); if (!body.active) await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }
    if (body.password) { Auth.checkPassword(body.password); await ctx.db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(Auth.hashPassword(body.password), id); await ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }
    await audit(ctx.db, user, 'user.update', String(id), { role: body.role, active: body.active, passwordChanged: !!body.password });
    return Auth.getUser(ctx.db, id);
  });

  /* ---------- mock-only: pretend a customer replied (for testing the loop without Meta) ---------- */
  r('POST', '/api/dev/simulate-reply', { perm: 'inbox.reply' }, async ({ body, user }) => {
    if (ctx.provider.name !== 'mock') throw httpError(404, 'Only available with WA_PROVIDER=mock');
    const m = cleanMobile(body.mobile); if (!m) throw httpError(400, 'Not a Bahrain mobile');
    ctx.provider.simulateInbound({ from: m, text: String(body.text || ''), kind: body.kind || 'text' });
    await ctx.provider.flush(); await ctx.processWebhooks();
    await audit(ctx.db, user, 'dev.simulate_reply', m, { chars: String(body.text || '').length }); // the text itself stays on the customer timeline, which erasure clears
    return { ok: true };
  });

  /* ---------- the handler ---------- */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const query = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname === '/webhook') {
        if (req.method === 'GET') { const v = W.verifyChallenge(ctx.cfg, query); return send(res, v.status, v.body); }
        if (req.method === 'POST') {
          const raw = await readBody(req, LIMIT_WEBHOOK);
          const out = await W.receive(ctx, raw, { 'x-hub-signature-256': req.headers['x-hub-signature-256'] });
          send(res, out.status, out.status === 200 ? 'EVENT_RECEIVED' : 'Invalid signature');
          if (out.stored) ctx.background(() => ctx.processWebhooks());
          return;
        }
        return send(res, 405, 'Method not allowed');
      }
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') return serveStatic(url.pathname, res);
      const route = routes.find(x => x.method === req.method && x.rx.test(url.pathname));
      if (!route) return send(res, routes.some(x => x.rx.test(url.pathname)) ? 405 : 404, { error: 'Not found' });
      const p = Object.fromEntries(route.keys.map((k, i) => [k, url.pathname.match(route.rx)[i + 1]]));
      let sess = null, user = null;
      if (route.auth !== false) {
        sess = await userFrom(req);
        if (!sess) return send(res, 401, { error: 'Please sign in' });
        user = sess.user;
        if (req.method !== 'GET') {
          if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused' });
          if (!Auth.csrfOk(sess, req.headers['x-csrf-token'])) return send(res, 403, { error: 'Missing or wrong CSRF token. Reload the page.' });
        }
        if (route.perm) Auth.must(user, route.perm);
      }
      let raw = null, body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        raw = await readBody(req, route.raw || LIMIT_JSON);
        if (!route.raw && raw.length) {
          if (!/application\/json/.test(String(req.headers['content-type']))) return send(res, 415, { error: 'Send JSON' });
          try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Bad JSON' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Bad JSON' });
        }
      }
      const out = await route.fn({ req, res, p, query, body, raw, user, sess });
      if (!res.headersSent && !res.writableEnded) send(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log('HTTP 500', req.method, url.pathname, String(e && e.stack || e));
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Server error — see the server log' : e.message, ...(e.headers ? { headers: e.headers, map: e.map } : {}) });
    }
  };
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel === '/index.html' ? 'no-store' : 'no-cache' });
  });
}

module.exports = { createApp, COOKIE };
