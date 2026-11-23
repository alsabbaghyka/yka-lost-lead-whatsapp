'use strict';
// Imports (the engine on the server) and campaigns: build -> submit -> approve
// (by someone else) -> start -> pause / resume / complete / cancel.
const { runEngine, detect, detectByContent, EX_LABEL, JOIN } = require('../rules/engine');
const { iso } = require('../rules/mobile');
const Q = require('../rules/sequence');
const C = require('../clock');
const Settings = require('../settings');
const Scheduler = require('./scheduler');
const { must } = require('../auth');
const { audit } = require('../audit');
const { tx } = require('../db');
const { bad, notFound, conflict, err } = require('./errors');

/** Insert many rows with multi-row VALUES (one round trip per chunk on a hosted database). */
async function insertMany(db, sqlHead, width, rows, tail = '', chunk = 100) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const ph = '(' + Array(width).fill('?').join(',') + ')';
    await db.prepare(`${sqlHead} VALUES ${part.map(() => ph).join(',')} ${tail}`).run(...part.flat());
  }
}

async function history(db) {
  const h = new Map();
  for (const r of await db.prepare("SELECT mobile, status FROM enrollments WHERE status IN ('optout','declined')").all()) h.set(r.mobile, { status: r.status });
  for (const r of await db.prepare("SELECT mobile, MAX(sent_at) lastAt FROM messages WHERE dir='out' AND sent_at IS NOT NULL GROUP BY mobile").all()) {
    const x = h.get(r.mobile) || {}; x.lastAt = r.lastAt; h.set(r.mobile, x);
  }
  return h;
}

/** Run the engine over uploaded rows and store the result. */
async function createImport(ctx, { fileName, rows, map, user, headerless = false }) {
  must(user, 'import');
  if (!Array.isArray(rows) || !rows.length) throw bad('The file has no rows');
  if (rows.length > 200000) throw bad('More than 200,000 rows: split the file');
  const headers = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const m = map && Object.keys(map).length ? map : (headerless ? detectByContent(rows, headers) : detect(headers));
  if (!m.mobile || !m.reason) { const e = bad('Could not find the mobile and loss reason columns. Pick them in the column mapping.'); e.headers = headers; e.map = m; throw e; }
  for (const k of Object.keys(m)) for (const h of (m[k] && !headers.includes(m[k]) ? m[k].split(JOIN) : [])) if (!headers.includes(h)) throw bad(`Column "${h}" is not in the file`);
  const s = await Settings.all(ctx.db), now = ctx.clock.now();
  const opts = { holdPct: s.holdout_pct, seed: s.holdout_key, consentFrom: s.consent_from || null, recentDays: s.recent_days, now, start: C.bahrainDate(now), defaultBrand: s.default_brand,
    optouts: new Set((await ctx.db.prepare('SELECT mobile FROM optouts').all()).map(r => r.mobile)),
    exclude: new Set((await ctx.db.prepare('SELECT mobile FROM suppressions').all()).map(r => r.mobile)),
    history: await history(ctx.db) };
  const o = runEngine(rows, m, opts);
  const summary = { total: o.total, unique: o.unique, send: o.send.length, holdout: o.hold.length + o.metaHold.length, meta: o.meta.length,
    excluded: o.excluded.length, exCount: o.exCount, bucketCount: o.bucketCount };
  const importId = await tx(ctx.db, async () => {
    const id = (await ctx.db.prepare('INSERT INTO imports(file_name, uploaded_by, created_at, row_count, mapping, options, summary) VALUES (?,?,?,?,?,?,?)')
      .run(String(fileName || 'upload').slice(0, 200), user.id, ctx.nowIso(), rows.length, JSON.stringify(m),
        JSON.stringify({ holdPct: opts.holdPct, seed: opts.seed, consentFrom: opts.consentFrom, recentDays: opts.recentDays }), JSON.stringify(summary))).lastInsertRowid;
    const row = (l, grp) => [id, l.i + 2, l.mobile || null, String(l.mobileRaw == null ? '' : l.mobileRaw).slice(0, 60), l.name, l.brand, l.model, l.reason.slice(0, 500), l.comments.slice(0, 1000),
      l.status, l.date ? iso(l.date) : null, l.sales, grp, l.bucket || null, l.track || null, l.exReason || null, l.tplName || null, l.vars ? JSON.stringify(l.vars) : null];
    const all = [...o.send.map(l => row(l, 'send')), ...o.hold.map(l => row(l, 'holdout')), ...o.meta.map(l => row(l, 'meta')),
      ...o.metaHold.map(l => row(l, 'meta_holdout')), ...o.excluded.map(l => row(l, 'excluded'))];
    await insertMany(ctx.db, 'INSERT INTO import_leads(import_id, row_no, mobile, mobile_raw, name, brand, model, reason, comments, status, lead_date, sales, grp, bucket, track, ex_reason, tpl_name, vars)', 18, all);
    return id;
  });
  await audit(ctx.db, user, 'import.create', fileName, { importId, ...summary, bucketCount: undefined });
  return { importId, summary, map: m, headers };
}

async function preview(ctx, importId, { limit = 2000 } = {}) {
  const imp = await ctx.db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
  if (!imp) throw notFound('No such import');
  const leads = grp => ctx.db.prepare('SELECT * FROM import_leads WHERE import_id = ? AND grp = ? ORDER BY row_no LIMIT ?').all(importId, grp, limit);
  const [send, hold, metaHold, meta, excluded] = await Promise.all(['send', 'holdout', 'meta_holdout', 'meta', 'excluded'].map(leads));
  return { import: { ...imp, mapping: JSON.parse(imp.mapping), options: JSON.parse(imp.options), summary: JSON.parse(imp.summary) },
    send, holdout: hold.concat(metaHold), meta, excluded: excluded.map(l => ({ ...l, ex_label: EX_LABEL[l.ex_reason] || l.ex_reason })) };
}
const listImports = async db => (await db.prepare('SELECT i.id, i.file_name, i.created_at, i.row_count, i.summary, u.name uploaded_by FROM imports i LEFT JOIN users u ON u.id = i.uploaded_by ORDER BY i.id DESC').all())
  .map(r => ({ ...r, summary: JSON.parse(r.summary) }));

async function getRow(ctx, id) { const c = await ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id); if (!c) throw notFound('No such campaign'); return c; }
/* column names come only from object literals in this file, never from input */
async function setStatus(ctx, id, status, extra = {}) {
  const keys = Object.keys(extra);
  await ctx.db.prepare(`UPDATE campaigns SET status = ?${keys.map(k => `, ${k} = ?`).join('')} WHERE id = ?`).run(status, ...keys.map(k => extra[k]), id);
}
const expect = (c, ...states) => { if (!states.includes(c.status)) throw conflict(`The campaign is ${c.status.replace('_', ' ')}; it must be ${states.join(' or ').replace('_', ' ')} for this`); };

async function createCampaign(ctx, { importId, name, startDate, user, language }) {
  must(user, 'campaign.build');
  if (!(await ctx.db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId))) throw notFound('No such import');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) throw bad('Day 0 must be a date (yyyy-mm-dd)');
  if (startDate < C.bahrainDate(ctx.clock.now())) throw bad('Day 0 cannot be in the past');
  const lang = language || await Settings.get(ctx.db, 'template_language');
  const r = await ctx.db.prepare("INSERT INTO campaigns(name, import_id, status, start_date, language, created_by, created_at) VALUES (?,?,'draft',?,?,?,?) RETURNING *")
    .get(String(name || '').trim().slice(0, 120) || `Campaign ${startDate}`, importId, startDate, lang, user.id, ctx.nowIso());
  await audit(ctx.db, user, 'campaign.create', String(r.id), { name: r.name, importId, startDate });
  return r;
}
async function submit(ctx, id, user) {
  must(user, 'campaign.build');
  const c = await getRow(ctx, id); expect(c, 'draft');
  if (c.created_by !== user.id && user.role !== 'admin') throw err(403, 'Only the person who built it (or an admin) can submit it');
  await setStatus(ctx, id, 'pending_approval', { submitted_at: ctx.nowIso() });
  await audit(ctx.db, user, 'campaign.submit', String(id));
}
async function approve(ctx, id, user) {
  must(user, 'campaign.approve');
  const c = await getRow(ctx, id); expect(c, 'pending_approval');
  if (c.created_by === user.id) throw err(403, 'A campaign must be approved by someone other than the person who built it');
  await setStatus(ctx, id, 'approved', { approved_by: user.id, approved_at: ctx.nowIso() });
  await audit(ctx.db, user, 'campaign.approve', String(id));
}
async function reject(ctx, id, user, note) {
  must(user, 'campaign.approve');
  const c = await getRow(ctx, id); expect(c, 'pending_approval');
  await setStatus(ctx, id, 'draft', { note: String(note || '').slice(0, 500) || null });
  await audit(ctx.db, user, 'campaign.reject', String(id), { note });
}
async function start(ctx, id, user) {
  must(user, 'campaign.control');
  const c = await getRow(ctx, id); expect(c, 'approved');
  const now = ctx.nowIso();
  const leads = await ctx.db.prepare("SELECT * FROM import_leads WHERE import_id = ? AND grp IN ('send','holdout') AND mobile IS NOT NULL").all(c.import_id);
  const optouts = new Set((await ctx.db.prepare("SELECT o.mobile FROM optouts o JOIN import_leads l ON l.mobile = o.mobile WHERE l.import_id = ?").all(c.import_id)).map(r => r.mobile));
  let optedOut = 0;
  await tx(ctx.db, async () => {
    // a customer seen before keeps their row (and history); their details are refreshed
    await insertMany(ctx.db, 'INSERT INTO customers(mobile, name, brand, model, sales, first_seen, last_seen)', 7, leads.map(l => [l.mobile, l.name, l.brand, l.model, l.sales, now, now]),
      'ON CONFLICT(mobile) DO UPDATE SET name = excluded.name, brand = excluded.brand, model = excluded.model, sales = excluded.sales, last_seen = excluded.last_seen');
    const ids = new Map((await ctx.db.prepare('SELECT c.id, c.mobile FROM customers c JOIN import_leads l ON l.mobile = c.mobile WHERE l.import_id = ?').all(c.import_id)).map(r => [r.mobile, r.id]));
    const enr = leads.map(l => {
      const st = Q.start({ track: l.track, bucket: l.bucket, group: l.grp });
      if (optouts.has(l.mobile)) { st.status = 'optout'; st.next = null; optedOut++; }
      return [id, ids.get(l.mobile), l.mobile, l.grp, st.bucket, l.track, l.sales, st.status, st.next ? st.next.key : null, st.next ? st.next.day : null, now];
    });
    await insertMany(ctx.db, 'INSERT OR IGNORE INTO enrollments(campaign_id, customer_id, mobile, grp, bucket, track, sales, status, next_key, next_day, updated_at)', 11, enr);
    await setStatus(ctx, id, 'running', { started_at: now });
  });
  await audit(ctx.db, user, 'campaign.start', String(id), { enrolled: leads.length, optedOutSinceImport: optedOut });
  return { enrolled: leads.length, optedOut };
}
async function pause(ctx, id, user) { must(user, 'campaign.control'); const c = await getRow(ctx, id); expect(c, 'running'); await setStatus(ctx, id, 'paused', { paused_at: ctx.nowIso() }); await audit(ctx.db, user, 'campaign.pause', String(id)); }
async function resume(ctx, id, user) { must(user, 'campaign.control'); const c = await getRow(ctx, id); expect(c, 'paused'); await setStatus(ctx, id, 'running'); await audit(ctx.db, user, 'campaign.resume', String(id)); }
async function complete(ctx, id, user) { must(user, 'campaign.control'); const c = await getRow(ctx, id); expect(c, 'running', 'paused'); await setStatus(ctx, id, 'completed', { completed_at: ctx.nowIso() }); await audit(ctx.db, user, 'campaign.complete', String(id)); }
async function cancel(ctx, id, user) {
  must(user, 'campaign.control');
  const c = await getRow(ctx, id);
  if (['completed', 'cancelled'].includes(c.status)) throw conflict('Already ' + c.status);
  await tx(ctx.db, async () => {
    await setStatus(ctx, id, 'cancelled');
    await ctx.db.prepare("UPDATE messages SET status = 'cancelled', outcome = 'Cancelled: the campaign was cancelled', updated_at = ? WHERE status = 'queued' AND automated = 1 AND enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = ?)").run(ctx.nowIso(), id);
  });
  await audit(ctx.db, user, 'campaign.cancel', String(id));
}

async function get(ctx, id) {
  const c = await ctx.db.prepare('SELECT c.*, u1.name created_by_name, u2.name approved_by_name FROM campaigns c LEFT JOIN users u1 ON u1.id = c.created_by LEFT JOIN users u2 ON u2.id = c.approved_by WHERE c.id = ?').get(id);
  if (!c) throw notFound('No such campaign');
  const counts = async sql => Object.fromEntries((await ctx.db.prepare(sql).all(id)).map(r => [r.k, r.n]));
  const [imp, statuses, groups, funnel, repliedRow, failures, waiting] = await Promise.all([
    ctx.db.prepare('SELECT file_name, summary FROM imports WHERE id = ?').get(c.import_id),
    counts('SELECT status k, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY status'),
    counts('SELECT grp k, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY grp'),
    counts(`SELECT m.status k, COUNT(*) n FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ? AND m.dir = 'out' AND m.kind = 'template' GROUP BY m.status`),
    ctx.db.prepare("SELECT COUNT(DISTINCT e.id) n FROM enrollments e JOIN messages m ON m.mobile = e.mobile AND m.dir = 'in' WHERE e.campaign_id = ? AND m.created_at >= COALESCE((SELECT started_at FROM campaigns WHERE id = ?), '')").get(id, id),
    ctx.db.prepare(`SELECT m.outcome, COUNT(*) n FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ? AND m.status IN ('failed','blocked') GROUP BY m.outcome ORDER BY n DESC`).all(id),
    c.status === 'running' ? Scheduler.waiting(ctx, id) : { test_mode: 0, template: 0, templates: [] }
  ]);
  return { campaign: c, import: imp ? { file_name: imp.file_name, summary: JSON.parse(imp.summary) } : null, statuses, groups, funnel, replied: repliedRow.n, failures, waiting };
}
const list = db => db.prepare('SELECT c.*, u1.name created_by_name, u2.name approved_by_name, (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id) enrolled FROM campaigns c LEFT JOIN users u1 ON u1.id = c.created_by LEFT JOIN users u2 ON u2.id = c.approved_by ORDER BY c.id DESC').all();

module.exports = { createImport, preview, listImports, createCampaign, submit, approve, reject, start, pause, resume, complete, cancel, get, list, history };
