'use strict';
// What each stored webhook event does: inbound replies drive the sequence
// rules (rules/sequence.js), statuses move messages on, template updates change
// approval. Called by webhook.processPending, never directly from HTTP.
const Q = require('../rules/sequence');
const { cleanMobile } = require('../rules/mobile');
const { isStop } = require('../rules/replies');
const { firstName } = require('../rules/templates');
const { classifyError } = require('../providers/errors');
const C = require('../clock');
const Opt = require('./optouts');
const Sender = require('./sender');
const Templates = require('./templates');
const { audit } = require('../audit');
const { tx } = require('../db');

const RANK = { queued: 0, sending: 0, accepted: 1, sent: 2, delivered: 3, read: 4, played: 4 };

function inboundText(m) {
  if (m.type === 'text' && m.text) return { kind: 'text', text: m.text.body || '' };
  if (m.type === 'button' && m.button) return { kind: 'button', text: m.button.text || m.button.payload || '' };
  if (m.type === 'interactive' && m.interactive) {
    const r = m.interactive.button_reply || m.interactive.list_reply || {};
    return { kind: 'interactive', text: r.title || r.id || '' };
  }
  return { kind: m.type || 'other', text: '' };
}

const stateOf = e => ({ status: e.status, group: e.grp, track: e.track, bucket: e.bucket, next: e.next_key ? { day: e.next_day, key: e.next_key } : null,
  tplCount: e.tpl_count, unanswered: e.unanswered, lastTpl: e.last_tpl, brief: e.brief });
function saveState(ctx, id, s) {
  ctx.db.prepare('UPDATE enrollments SET status = ?, next_key = ?, next_day = ?, tpl_count = ?, unanswered = ?, last_tpl = ?, brief = ?, updated_at = ? WHERE id = ?')
    .run(s.status, s.next ? s.next.key : null, s.next ? s.next.day : null, s.tplCount, s.unanswered, s.lastTpl || null, s.brief || null, ctx.nowIso(), id);
}
const dateLabelFor = start => d => C.shortDate(C.addDaysIso(start, d));

/** {name} {brand} {sales} in automatic replies */
const fillReply = (body, cust, e) => body.replace(/\{name\}/g, firstName(cust && cust.name)).replace(/\{brand\}/g, (cust && cust.brand) || 'Y.K. Almoayyed')
  .replace(/\{sales\}/g, (e && e.sales) || (cust && cust.sales) || 'our sales team');

function salesUserFor(ctx, name) {
  if (!name) return null;
  const u = ctx.db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('sales','marketing','admin') AND lower(trim(name)) = lower(trim(?))").get(name);
  return u ? u.id : null;
}

function onMessage(ctx, { message: m, contacts = [], metadata = {} }) {
  if (ctx.cfg.phoneNumberId && metadata.phone_number_id && String(metadata.phone_number_id) !== String(ctx.cfg.phoneNumberId))
    return `ignored: phone number id ${metadata.phone_number_id} is not this system's`;
  const contact = contacts[0] || {};
  const userId = m.from_user_id || contact.user_id || null;
  let mobile = cleanMobile(m.from || contact.wa_id);
  let cust = mobile ? ctx.db.prepare('SELECT * FROM customers WHERE mobile = ?').get(mobile) : null;
  if (!cust && !mobile && userId) { cust = ctx.db.prepare('SELECT * FROM customers WHERE wa_user_id = ?').get(userId); if (cust) mobile = cust.mobile; }
  if (!mobile) return 'no Bahrain mobile and unknown WhatsApp user id: kept in the event log only';
  const { kind, text } = inboundText(m);
  const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : ctx.nowIso();
  return tx(ctx.db, () => {
    const ins = ctx.db.prepare(`INSERT OR IGNORE INTO messages(customer_id, mobile, dir, kind, body, wamid, status, automated, created_at, updated_at)
      VALUES (?,?,'in',?,?,?,'received',0,?,?)`).run(cust ? cust.id : null, mobile, kind, text, m.id, at, ctx.nowIso());
    if (!ins.changes) return 'duplicate message id';
    if (cust) ctx.db.prepare('UPDATE customers SET last_inbound_at = MAX(COALESCE(last_inbound_at, \'\'), ?), wa_user_id = COALESCE(?, wa_user_id) WHERE id = ?').run(at, userId, cust.id);
    const e = cust ? ctx.db.prepare('SELECT * FROM enrollments WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(cust.id) : null;
    if (!e) {
      if (isStop(text)) {
        const r = Opt.addOptout(ctx, mobile, { source: 'whatsapp_reply', text });
        if (cust && r.added) Sender.enqueueText(ctx, { mobile, body: 'You are unsubscribed. We will not message you again.', key: 'optout_confirm', automated: true });
        return 'opt-out from someone not in a campaign';
      }
      return cust ? 'customer not in a campaign: kept on the timeline' : 'unknown sender: kept on the timeline';
    }
    const camp = ctx.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(e.campaign_id);
    const day = Math.max(0, C.dayIndex(camp.start_date, ctx.clock.now()));
    const r = Q.onReply(stateOf(e), text, day, { dateLabel: dateLabelFor(camp.start_date) });
    saveState(ctx, e.id, r.state);
    // a person now has the customer (or they said no): their other campaigns stop too
    if (['handover', 'declined'].includes(r.state.status) && r.state.status !== e.status) {
      ctx.db.prepare("UPDATE enrollments SET status = ?, next_key = NULL, next_day = NULL, brief = ?, updated_at = ? WHERE customer_id = ? AND id <> ? AND status IN ('queued','active','asked')")
        .run(r.state.status === 'declined' ? 'declined' : 'done', r.state.status === 'declined' ? 'Declined updates in another campaign' : `Stopped: with the salesperson from campaign ${camp.name}`, ctx.nowIso(), cust.id, e.id);
    }
    for (const a of r.actions) {
      if (a.type === 'optout') Opt.addOptout(ctx, mobile, { source: 'whatsapp_reply', text });
      else if (a.type === 'handover') {
        ctx.db.prepare('UPDATE enrollments SET handover_at = ?, handover_user = COALESCE(handover_user, ?), resolved_at = NULL, resolved_by = NULL WHERE id = ?')
          .run(ctx.nowIso(), salesUserFor(ctx, e.sales), e.id);
        audit(ctx.db, null, 'handover', mobile, { enrollment: e.id, why: a.why, salesperson: e.sales });
      } else if (a.type === 'text') {
        const optConfirm = r.actions.some(x => x.type === 'optout');
        Sender.enqueueText(ctx, { mobile, enrollmentId: e.id, body: fillReply(a.body, cust, e), automated: true, key: optConfirm ? 'optout_confirm' : 'auto_reply' });
      }
    }
    if (r.actions.some(x => x.type === 'optout') && !r.actions.some(x => x.type === 'text'))
      Sender.enqueueText(ctx, { mobile, enrollmentId: e.id, body: 'You are unsubscribed. We will not message you again.', key: 'optout_confirm', automated: true });
    return null;
  });
}

function onStatus(ctx, { status: s, metadata = {} }) {
  if (ctx.cfg.phoneNumberId && metadata.phone_number_id && String(metadata.phone_number_id) !== String(ctx.cfg.phoneNumberId))
    return `ignored: phone number id ${metadata.phone_number_id} is not this system's`;
  const m = ctx.db.prepare('SELECT * FROM messages WHERE wamid = ?').get(s.id);
  if (!m) return 'status for a message this system did not send';
  if (s.status === 'failed') {
    const e0 = (s.errors || [])[0] || {};
    const err = classifyError({ code: e0.code, title: e0.title || e0.message, details: e0.error_data && e0.error_data.details });
    ctx.db.prepare("UPDATE messages SET status = 'failed', error_code = ?, error_title = ?, outcome = ?, updated_at = ? WHERE id = ?")
      .run(err.code, err.title, err.label, ctx.nowIso(), m.id);
    Sender.applyFailureEffects(ctx, m, err);
    return null;
  }
  if (m.status !== 'failed' && (RANK[s.status] || 0) > (RANK[m.status] || 0))
    ctx.db.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?').run(s.status, ctx.nowIso(), m.id);
  return null;
}

function handleEvent(ctx, kind, payload) {
  if (kind === 'message') return onMessage(ctx, payload);
  if (kind === 'status') return onStatus(ctx, payload);
  if (kind === 'template') { Templates.applyStatusUpdate(ctx, payload); return null; }
  if (kind === 'error') { audit(ctx.db, null, 'meta.error', String(payload.error && payload.error.code || ''), payload.error); return null; }
  return 'unhandled webhook field';
}

module.exports = { handleEvent, inboundText, stateOf, saveState, fillReply, dateLabelFor };
