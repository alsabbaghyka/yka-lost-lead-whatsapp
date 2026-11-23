'use strict';
// Template approval as Meta reports it. Only APPROVED is ever sent; a template
// the sync has never seen counts as not approved.
const T = require('../rules/templates');
const { must } = require('../auth');
const { audit } = require('../audit');
const { tx } = require('../db');

const normLang = l => String(l || '').replace('-', '_');

async function sync(ctx, user) {
  if (user) must(user, 'templates.sync');
  const list = await ctx.provider.listTemplates();
  const now = ctx.nowIso();
  const seen = new Set();
  await tx(ctx.db, async () => {
    for (const t of list) {
      const lang = normLang(t.language);
      seen.add(t.name + '|' + lang);
      await ctx.db.prepare(`INSERT INTO templates(name, language, status, category, meta_id, body, reason, synced_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(name, language) DO UPDATE SET status=excluded.status, category=excluded.category, meta_id=excluded.meta_id, body=excluded.body, reason=excluded.reason, synced_at=excluded.synced_at`)
        .run(t.name, lang, String(t.status || 'UNKNOWN').toUpperCase(), t.category || null, t.id || null, t.body || null, t.reason || null, now);
    }
    for (const r of await ctx.db.prepare('SELECT name, language FROM templates').all())
      if (!seen.has(r.name + '|' + r.language)) await ctx.db.prepare("UPDATE templates SET status = 'NOT_FOUND', synced_at = ? WHERE name = ? AND language = ?").run(now, r.name, r.language);
  });
  const approved = list.filter(t => String(t.status).toUpperCase() === 'APPROVED').length;
  await audit(ctx.db, user || null, 'templates.sync', ctx.provider.name, { total: list.length, approved });
  return { total: list.length, approved };
}

/** {ok, status} for a template name in a language. */
async function approval(db, name, language) {
  const r = await db.prepare('SELECT status FROM templates WHERE name = ? AND language = ?').get(name, normLang(language));
  if (!r) return { ok: false, status: 'UNKNOWN' };
  return { ok: r.status === 'APPROVED', status: r.status };
}

async function applyStatusUpdate(ctx, v) {
  const lang = normLang(v.message_template_language);
  const ev = String(v.event || '').toUpperCase();
  const status = ev === 'REINSTATED' || ev === 'UNARCHIVED' ? 'APPROVED' : ev === 'FLAGGED' ? 'APPROVED' : ev;
  await ctx.db.prepare(`INSERT INTO templates(name, language, status, meta_id, reason, synced_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(name, language) DO UPDATE SET status=excluded.status, reason=excluded.reason, synced_at=excluded.synced_at`)
    .run(v.message_template_name, lang, status, String(v.message_template_id || ''), v.reason || null, ctx.nowIso());
  await audit(ctx.db, null, 'templates.status_update', v.message_template_name, { language: lang, event: ev, reason: v.reason || null });
}

/** The catalogue next to what Meta says about each template. */
async function list(db, language = 'en') {
  const rows = await db.prepare('SELECT * FROM templates').all();
  const find = (n, l) => rows.find(r => r.name === n && r.language === normLang(l));
  return T.CATALOGUE.map(t => {
    const en = find(t.name, language), ar = find(t.name, 'ar');
    return { key: t.key, name: t.name, category: t.category, draft: !!t.draft, body: t.body.en, metaBody: T.tplBody(t.body.en), variables: T.tplVars(t.body.en),
      status: en ? en.status : 'UNKNOWN', reason: en ? en.reason : null, synced_at: en ? en.synced_at : null, arabicStatus: ar ? ar.status : 'UNKNOWN' };
  });
}

/** Rows to submit to Meta: English bodies, Arabic placeholders, drafts marked. */
function submissionRows() {
  const out = [['template_name', 'language', 'category', 'body', 'variables', 'note']];
  for (const t of T.CATALOGUE) {
    const vars = T.tplVars(t.body.en).map((v, i) => `{{${i + 1}}}=${v}`).join(' | ');
    out.push([t.name, 'en', t.category, T.tplBody(t.body.en), vars, t.draft ? 'DRAFT — wording not yet agreed; do not submit until signed off' : 'Day 0 / permission: engine wording']);
    out.push([t.name, 'ar', t.category, t.body.ar ? T.tplBody(t.body.ar) : `[ARABIC TRANSLATION NEEDED — keep the same variables in the same order: ${vars}]`, vars, 'PLACEHOLDER — needs a translator, then Meta approval' + (t.draft ? '; English is a draft too' : '')]);
  }
  return out;
}

module.exports = { sync, approval, applyStatusUpdate, list, submissionRows, normLang };
