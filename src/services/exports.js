'use strict';
// CSV files for the CRM and for checking: the engine's exports plus the CRM write-back.
const { firstName } = require('../rules/templates');
const { bucketById } = require('../rules/buckets');
const { addDays } = require('../rules/mobile');
const Templates = require('./templates');
const { notFound } = require('./errors');

/* Excel runs a cell starting = + - @ as a formula; prefix those with ' — except plain phone numbers */
const safe = s => (/^[=+\-@\t\r]/.test(s) && !/^\+?\d[\d ]*$/.test(s) ? "'" + s : s);
function csv(rows) {
  return rows.map(r => r.map(v => { const s = safe(String(v == null ? '' : v)); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
}
const bname = id => (bucketById(id) || {}).name || '';

async function importCsv(ctx, importId, kind) {
  const imp = await ctx.db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
  if (!imp) throw notFound('No such import');
  const start = await ctx.db.prepare('SELECT start_date FROM campaigns WHERE import_id = ? ORDER BY id DESC LIMIT 1').get(importId);
  const day0 = start ? start.start_date : imp.created_at.slice(0, 10);
  const leads = grps => ctx.db.prepare(`SELECT * FROM import_leads WHERE import_id = ? AND grp IN (${grps.map(() => '?').join(',')}) ORDER BY row_no`).all(importId, ...grps);
  if (kind === 'send') return csv([['mobile', 'first_name', 'brand', 'model', 'bucket', 'track', 'template_name', 'var1', 'var2', 'var3', 'day0', 'day2', 'day7', 'day30', 'salesperson']]
    .concat((await leads(['send'])).map(l => { const v = JSON.parse(l.vars || '[]'); return [l.mobile, firstName(l.name), l.brand, l.model, bname(l.bucket), l.track, l.tpl_name, v[0] || '', v[1] || '', v[2] || '', day0, addDays(day0, 2), addDays(day0, 7), addDays(day0, 30), l.sales]; })));
  if (kind === 'holdout') return csv([['mobile', 'brand', 'model', 'bucket', 'holdout_since']].concat((await leads(['holdout', 'meta_holdout'])).map(l => [l.mobile, l.brand, l.model, bname(l.bucket), day0])));
  if (kind === 'meta') return csv([['phone', 'country']].concat((await leads(['meta'])).map(l => [l.mobile.replace('+', ''), 'BH'])));
  if (kind === 'excluded') {
    const { EX_LABEL } = require('../rules/engine');
    return csv([['row', 'mobile_as_given', 'brand', 'model', 'loss_reason', 'status', 'excluded_because']].concat((await leads(['excluded'])).map(l => [l.row_no, l.mobile_raw, l.brand, l.model, l.reason, l.status, EX_LABEL[l.ex_reason] || l.ex_reason])));
  }
  throw notFound('Unknown export ' + kind);
}

const STATUS_LABEL = { queued: 'Waiting to send', active: 'In sequence', asked: 'Asked permission', optout: 'Opted out', handover: 'With salesperson', quiet: 'No reply',
  declined: 'Declined', failed: 'Not delivered', listed: 'On a do-not-contact list', holdout: 'Holdout (not messaged)', done: 'Resolved by salesperson' };
async function crmWriteback(ctx, campaignId) {
  const c = await ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!c) throw notFound('No such campaign');
  const rows = await ctx.db.prepare(`SELECT e.*, cu.name, cu.brand, cu.model, u.name handover_name,
      (SELECT MAX(created_at) FROM messages m WHERE m.mobile = e.mobile) last_at,
      (SELECT 1 FROM optouts o WHERE o.mobile = e.mobile) opted
    FROM enrollments e JOIN customers cu ON cu.id = e.customer_id LEFT JOIN users u ON u.id = e.handover_user WHERE e.campaign_id = ? ORDER BY e.id`).all(campaignId);
  return csv([['mobile', 'first_name', 'brand', 'model', 'campaign', 'group', 'status', 'outcome', 'last_message_at', 'salesperson', 'handed_over_at', 'resolved_at', 'opted_out']]
    .concat(rows.map(r => [r.mobile, firstName(r.name), r.brand, r.model, c.name, r.grp, STATUS_LABEL[r.status] || r.status, r.brief || '', r.last_at || '',
      r.handover_name || r.sales || '', r.handover_at || '', r.resolved_at || '', r.opted ? 'yes' : 'no'])));
}
const optoutsCsv = async ctx => csv([['mobile', 'opted_out_on', 'source']].concat((await ctx.db.prepare('SELECT mobile, at, source FROM optouts ORDER BY at').all()).map(r => [r.mobile, r.at.slice(0, 10), r.source])));
const templatesCsv = () => csv(Templates.submissionRows());

module.exports = { csv, importCsv, crmWriteback, optoutsCsv, templatesCsv, STATUS_LABEL };
