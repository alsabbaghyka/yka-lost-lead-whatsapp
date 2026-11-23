'use strict';
// Imports (the engine on the server) and campaigns: build -> submit -> approve
// (by someone else) -> start -> pause / resume / complete / cancel.
const { runEngine, detect, detectByContent, EX_LABEL } = require('../rules/engine');
const { iso } = require('../rules/mobile');
const Q = require('../rules/sequence');
const C = require('../clock');
const Settings = require('../settings');
const Opt = require('./optouts');
const Scheduler = require('./scheduler');
const { must } = require('../auth');
const { audit } = require('../audit');
const { tx } = require('../db');
const { bad, notFound, conflict, err } = require('./errors');

function history(db) {
  const h = new Map();
  for (const r of db.prepare("SELECT mobile, status FROM enrollments WHERE status IN ('optout','declined')").all()) h.set(r.mobile, { status: r.status });
  for (const r of db.prepare("SELECT mobile, MAX(sent_at) lastAt FROM messages WHERE dir='out' AND sent_at IS NOT NULL GROUP BY mobile").all()) {
    const x = h.get(r.mobile) || {}; x.lastAt = r.lastAt; h.set(r.mobile, x);
  }
  return h;
}

/** Run the engine over uploaded rows and store the result. */
function createImport(ctx, { fileName, rows, map, user, headerless = false }) {
  must(user, 'import');
  if (!Array.isArray(rows) || !rows.length) throw bad('The file has no rows');
  if (rows.length > 200000) throw bad('More than 200,000 rows: split the file');
  const headers = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const m = map && Object.keys(map).length ? map : (headerless ? detectByContent(rows, headers) : detect(headers));
  if (!m.mobile || !m.reason) { const e = bad('Could not find the mobile and loss reason columns. Pick them in the column mapping.'); e.headers = headers; e.map = m; throw e; }
  for (const k of Object.keys(m)) if (m[k] && !headers.includes(m[k])) throw bad(`Column "${m[k]}" is not in the file`);
  const s = Settings.all(ctx.db), now = ctx.clock.now();
  const opts = { holdPct: s.holdout_pct, seed: s.holdout_key, consentFrom: s.consent_from || null, recentDays: s.recent_days, now, start: C.bahrainDate(now),
    optouts: new Set(ctx.db.prepare('SELECT mobile FROM optouts').all().map(r => r.mobile)),
    exclude: new Set(ctx.db.prepare('SELECT mobile FROM suppressions').all().map(r => r.mobile)),
    history: history(ctx.db) };
  const o = runEngine(rows, m, opts);
  const summary = { total: o.total, unique: o.unique, send: o.send.length, holdout: o.hold.length + o.metaHold.length, meta: o.meta.length,
    excluded: o.excluded.length, exCount: o.exCount, bucketCount: o.bucketCount };
  const importId = tx(ctx.db, () => {
    const id = Number(ctx.db.prepare('INSERT INTO imports(file_name, uploaded_by, created_at, row_count, mapping, options, summary) VALUES (?,?,?,?,?,?,?)')
      .run(String(fileName || 'upload').slice(0, 200), user.id, ctx.nowIso(), rows.length, JSON.stringify(m),
        JSON.stringify({ holdPct: opts.holdPct, seed: opts.seed, consentFrom: opts.consentFrom, recentDays: opts.recentDays }), JSON.stringify(summary)).lastInsertRowid);
    const ins = ctx.db.prepare(`INSERT INTO import_leads(import_id, row_no, mobile, mobile_raw, name, brand, model, reason, comments, status, lead_date, sales, grp, bucket, track, ex_reason, tpl_name, vars)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const put = (l, grp) => ins.run(id, l.i + 2, l.mobile || null, String(l.mobileRaw == null ? '' : l.mobileRaw).slice(0, 60), l.name, l.brand, l.model, l.reason.slice(0, 500), l.comments.slice(0, 1000),
      l.status, l.date ? iso(l.date) : null, l.sales, grp, l.bucket || null, l.track || null, l.exReason || null, l.tplName || null, l.vars ? JSON.stringify(l.vars) : null);
    o.send.forEach(l => put(l, 'send')); o.hold.forEach(l => put(l, 'holdout'));
    o.meta.forEach(l => put(l, 'meta')); o.metaHold.forEach(l => put(l, 'meta_holdout'));
    o.excluded.forEach(l => put(l, 'excluded'));
    return id;
  });
  audit(ctx.db, user, 'import.create', fileName, { importId, ...summary, bucketCount: undefined });
  return { importId, summary, map: m, headers };
}

function preview(ctx, importId, { limit = 2000 } = {}) {
  const imp = ctx.db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
  if (!imp) throw notFound('No such import');
  const leads = grp => ctx.db.prepare('SELECT * FROM import_leads WHERE import_id = ? AND grp = ? ORDER BY row_no LIMIT ?').all(importId, grp, limit);
  return { import: { ...imp, mapping: JSON.parse(imp.mapping), options: JSON.parse(imp.options), summary: JSON.parse(imp.summary) },
    send: leads('send'), holdout: leads('holdout').concat(leads('meta_holdout')), meta: leads('meta'),
    excluded: leads('excluded').map(l => ({ ...l, ex_label: EX_LABEL[l.ex_reason] || l.ex_reason })) };
}
const listImports = db => db.prepare('SELECT i.id, i.file_name, i.created_at, i.row_count, i.summary, u.name uploaded_by FROM imports i LEFT JOIN users u ON u.id = i.uploaded_by ORDER BY i.id DESC').all()
  .map(r => ({ ...r, summary: JSON.parse(r.summary) }));

const getRow = (ctx, id) => { const c = ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id); if (!c) throw notFound('No such campaign'); return c; };
const setStatus = (ctx, id, status, extra = {}) => {
  const keys = Object.keys(extra);
  ctx.db.prepare(`UPDATE campaigns SET status = ?${keys.map(k => `, ${k} = ?`).join('')} WHERE id = ?`).run(status, ...keys.map(k => extra[k]), id);
};
const expect = (c, ...states) => { if (!states.includes(c.status)) throw conflict(`The campaign is ${c.status.replace('_', ' ')}; it must be ${states.join(' or ').replace('_', ' ')} for this`); };

function createCampaign(ctx, { importId, name, startDate, user, language }) {
  must(user, 'campaign.build');
  if (!ctx.db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) throw notFound('No such import');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) throw bad('Day 0 must be a date (yyyy-mm-dd)');
  if (startDate < C.bahrainDate(ctx.clock.now())) throw bad('Day 0 cannot be in the past');
  const lang = language || Settings.get(ctx.db, 'template_language');
  const r = ctx.db.prepare("INSERT INTO campaigns(name, import_id, status, start_date, language, created_by, created_at) VALUES (?,?,'draft',?,?,?,?) RETURNING *")
    .get(String(name || '').trim().slice(0, 120) || `Campaign ${startDate}`, importId, startDate, lang, user.id, ctx.nowIso());
  audit(ctx.db, user, 'campaign.create', String(r.id), { name: r.name, importId, startDate });
  return r;
}
function submit(ctx, id, user) {
  must(user, 'campaign.build');
  const c = getRow(ctx, id); expect(c, 'draft');
  if (c.created_by !== user.id && user.role !== 'admin') throw err(403, 'Only the person who built it (or an admin) can submit it');
  setStatus(ctx, id, 'pending_approval', { submitted_at: ctx.nowIso() });
  audit(ctx.db, user, 'campaign.submit', String(id));
}
function approve(ctx, id, user) {
  must(user, 'campaign.approve');
  const c = getRow(ctx, id); expect(c, 'pending_approval');
  if (c.created_by === user.id) throw err(403, 'A campaign must be approved by someone other than the person who built it');
  setStatus(ctx, id, 'approved', { approved_by: user.id, approved_at: ctx.nowIso() });
  audit(ctx.db, user, 'campaign.approve', String(id));
}
function reject(ctx, id, user, note) {
  must(user, 'campaign.approve');
  const c = getRow(ctx, id); expect(c, 'pending_approval');
  setStatus(ctx, id, 'draft', { note: String(note || '').slice(0, 500) || null });
  audit(ctx.db, user, 'campaign.reject', String(id), { note });
}
function start(ctx, id, user) {
  must(user, 'campaign.control');
  const c = getRow(ctx, id); expect(c, 'approved');
  const now = ctx.nowIso();
  const leads = ctx.db.prepare("SELECT * FROM import_leads WHERE import_id = ? AND grp IN ('send','holdout') AND mobile IS NOT NULL").all(c.import_id);
  let optedOut = 0;
  tx(ctx.db, () => {
    for (const l of leads) {
      const cust = ctx.db.prepare(`INSERT INTO customers(mobile, name, brand, model, sales, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(mobile) DO UPDATE SET name = excluded.name, brand = excluded.brand, model = excluded.model, sales = excluded.sales, last_seen = excluded.last_seen RETURNING id`)
        .get(l.mobile, l.name, l.brand, l.model, l.sales, now, now);
      const s = Q.start({ track: l.track, bucket: l.bucket, group: l.grp });
      if (Opt.isOptedOut(ctx.db, l.mobile)) { s.status = 'optout'; s.next = null; optedOut++; }
      ctx.db.prepare(`INSERT OR IGNORE INTO enrollments(campaign_id, customer_id, mobile, grp, bucket, track, sales, status, next_key, next_day, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, cust.id, l.mobile, l.grp, s.bucket, l.track, l.sales, s.status, s.next ? s.next.key : null, s.next ? s.next.day : null, now);
    }
    setStatus(ctx, id, 'running', { started_at: now });
  });
  audit(ctx.db, user, 'campaign.start', String(id), { enrolled: leads.length, optedOutSinceImport: optedOut });
  return { enrolled: leads.length, optedOut };
}
function pause(ctx, id, user) { must(user, 'campaign.control'); const c = getRow(ctx, id); expect(c, 'running'); setStatus(ctx, id, 'paused', { paused_at: ctx.nowIso() }); audit(ctx.db, user, 'campaign.pause', String(id)); }
function resume(ctx, id, user) { must(user, 'campaign.control'); const c = getRow(ctx, id); expect(c, 'paused'); setStatus(ctx, id, 'running'); audit(ctx.db, user, 'campaign.resume', String(id)); }
function complete(ctx, id, user) { must(user, 'campaign.control'); const c = getRow(ctx, id); expect(c, 'running', 'paused'); setStatus(ctx, id, 'completed', { completed_at: ctx.nowIso() }); audit(ctx.db, user, 'campaign.complete', String(id)); }
function cancel(ctx, id, user) {
  must(user, 'campaign.control');
  const c = getRow(ctx, id);
  if (['completed', 'cancelled'].includes(c.status)) throw conflict('Already ' + c.status);
  tx(ctx.db, () => {
    setStatus(ctx, id, 'cancelled');
    ctx.db.prepare("UPDATE messages SET status = 'cancelled', outcome = 'Cancelled: the campaign was cancelled', updated_at = ? WHERE status = 'queued' AND automated = 1 AND enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = ?)").run(ctx.nowIso(), id);
  });
  audit(ctx.db, user, 'campaign.cancel', String(id));
}

function get(ctx, id) {
  const c = ctx.db.prepare('SELECT c.*, u1.name created_by_name, u2.name approved_by_name FROM campaigns c LEFT JOIN users u1 ON u1.id = c.created_by LEFT JOIN users u2 ON u2.id = c.approved_by WHERE c.id = ?').get(id);
  if (!c) throw notFound('No such campaign');
  const imp = ctx.db.prepare('SELECT file_name, summary FROM imports WHERE id = ?').get(c.import_id);
  const statuses = Object.fromEntries(ctx.db.prepare('SELECT status, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY status').all(id).map(r => [r.status, r.n]));
  const groups = Object.fromEntries(ctx.db.prepare('SELECT grp, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY grp').all(id).map(r => [r.grp, r.n]));
  const funnel = Object.fromEntries(ctx.db.prepare(`SELECT m.status, COUNT(*) n FROM messages m JOIN enrollments e ON e.id = m.enrollment_id
    WHERE e.campaign_id = ? AND m.dir = 'out' AND m.kind = 'template' GROUP BY m.status`).all(id).map(r => [r.status, r.n]));
  const replied = ctx.db.prepare("SELECT COUNT(DISTINCT e.id) n FROM enrollments e JOIN messages m ON m.mobile = e.mobile AND m.dir = 'in' WHERE e.campaign_id = ? AND m.created_at >= COALESCE((SELECT started_at FROM campaigns WHERE id = ?), '')").get(id, id).n;
  const failures = ctx.db.prepare(`SELECT m.outcome, COUNT(*) n FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ? AND m.status IN ('failed','blocked') GROUP BY m.outcome ORDER BY n DESC`).all(id);
  return { campaign: c, import: imp ? { file_name: imp.file_name, summary: JSON.parse(imp.summary) } : null, statuses, groups, funnel, replied, failures,
    waiting: c.status === 'running' ? Scheduler.waiting(ctx, id) : { test_mode: 0, template: 0, templates: [] } };
}
const list = db => db.prepare('SELECT c.*, u1.name created_by_name, u2.name approved_by_name, (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id) enrolled FROM campaigns c LEFT JOIN users u1 ON u1.id = c.created_by LEFT JOIN users u2 ON u2.id = c.approved_by ORDER BY c.id DESC').all();

module.exports = { createImport, preview, listImports, createCampaign, submit, approve, reject, start, pause, resume, complete, cancel, get, list, history };
