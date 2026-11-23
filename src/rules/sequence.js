'use strict';
// The follow-up sequence and reply rules, ported from lost-lead-engine/simulator.html
// (sendTemplate / receive) as a pure state machine. Days are whole days counted
// from the campaign's Day 0. The caller decides *when* a day happens (Friday,
// quiet hours, opt-out list); this module only decides *what* happens.
//
//   Day 0 bucket message -> Day 2 nudge -> Day 7 voucher -> Day 30 monthly, then monthly
//   Three templates in a row with no answer: stop ("quiet").
//   Old leads (permission track) get the permission request first; YES starts the
//   bucket message two days later, NO closes, anything else goes to a person.
//   Replies: STOP (EN/AR) opts out; 1-4 answer the ask-reason template;
//   any other free text hands the customer to their salesperson and pauses automation.
const { isStop, isYes, isNo, isCall, clip } = require('./replies');
const { BUCKET_KEY } = require('./templates');

const ACTIVE = ['queued', 'active'];
const BUCKET_NAME = { price: 'Price or finance', stock: 'Waiting for stock', thinking: 'Still thinking', competitor: 'Bought elsewhere',
  features: "Product didn't fit", family: 'Family said no', ask: 'No reason / stopped responding' };
const dayLabel = (opts, d) => (opts && opts.dateLabel ? opts.dateLabel(d) : 'day ' + d);

/** Initial state for one enrolled customer. bucket may be an engine id (noresp) or a key (ask). */
function start({ track = 'standard', bucket, group = 'send' }) {
  const key = BUCKET_KEY[bucket] || bucket;
  const hold = group === 'holdout';
  return { status: hold ? 'holdout' : 'queued', group, track, bucket: key,
    next: hold ? null : { day: 0, key: track === 'permission' ? 'permission' : key },
    tplCount: 0, unanswered: 0, lastTpl: null };
}
const isDue = (s, day, includeHandover = false) => !!(s.next && s.next.day <= day &&
  (ACTIVE.includes(s.status) || (includeHandover && s.status === 'handover')));
const deferTo = (s, day) => ({ ...s, next: s.next ? { ...s.next, day } : null });
const onListed = s => ({ ...s, status: 'listed', next: null });
const afterFailed = (s, opts) => ({ ...s, status: 'failed', next: null, tplCount: s.tplCount + 1,
  brief: 'Not delivered — number not reachable on WhatsApp' + (opts && opts.reason ? ' (' + opts.reason + ')' : '') });

/** A template was accepted for sending on `day`. */
function afterTemplate(s0, key, day, opts) {
  const s = { ...s0, tplCount: s0.tplCount + 1, unanswered: s0.unanswered + 1, lastTpl: key };
  let outcome = null;
  if (s.status === 'queued') s.status = 'active';
  if (key === 'permission') {
    s.status = 'asked'; s.next = null;
    outcome = { status: 'asked', brief: 'Asked for permission on ' + dayLabel(opts, day) + ' — no answer yet' };
  } else if (s.unanswered >= 3) {
    s.status = 'quiet'; s.next = null;
    outcome = { status: 'quiet', brief: 'Went quiet — 3 messages unanswered, sequence stopped ' + dayLabel(opts, day) };
  } else {
    if (key === 'nudge') s.next = { day: Math.max(day + 5, 7), key: 'voucher' };
    else if (key === 'voucher') s.next = { day: Math.max(day + 23, 30), key: 'monthly' };
    else if (key === 'monthly') s.next = { day: day + 30, key: 'monthly' };
    else s.next = { day: day + 2, key: 'nudge' };
    if (s.tplCount === 1) outcome = { status: 'active', brief: 'In sequence — first message (' + (BUCKET_NAME[s.bucket] || s.bucket) + ') sent ' + dayLabel(opts, day) };
  }
  if (outcome) s.brief = outcome.brief;
  return { state: s, outcome };
}

/**
 * A customer replied. Returns {state, actions, outcome}. actions:
 *   {type:'text', body}       free-form reply (inside the 24h window); {name} {brand} {sales} are filled by the caller
 *   {type:'optout'}           add to the global opt-out list
 *   {type:'handover', why}    give to the salesperson; automation is paused
 */
function onReply(s0, text, day, opts = {}) {
  const s = { ...s0, unanswered: 0 };
  const actions = [];
  const done = (status, brief) => { s.brief = brief; return { state: s, actions, outcome: status ? { status, brief } : null }; };
  if (s.status === 'optout') return { state: s0, actions, outcome: null };
  if (isStop(text)) {
    s.status = 'optout'; s.next = null;
    actions.push({ type: 'optout' }, { type: 'text', body: 'You are unsubscribed. We will not message you again.' });
    return done('optout', 'Opted out — replied ' + (String(text).trim().toUpperCase() === 'STOP' ? 'STOP' : '“' + clip(text) + '”') + ' on ' + dayLabel(opts, day));
  }
  const handover = (why, brief) => {
    s.status = 'handover';
    if (!opts.keepSequenceOnHandover) s.next = null;
    actions.push({ type: 'handover', why }, { type: 'text', body: 'Thanks {name}. {sales} from {brand} will contact you shortly.' });
    return done('handover', brief + ' — handed to the salesperson on ' + dayLabel(opts, day));
  };
  if (s.status === 'handover') return { state: s, actions, outcome: null }; // left to the salesperson
  if (['holdout', 'listed', 'failed', 'declined'].includes(s.status)) {
    // they wrote in unprompted: a person answers, nothing automated is sent
    actions.push({ type: 'handover', why: 'wrote in while not in an active sequence' });
    s.status = s.status === 'holdout' ? 'holdout' : 'handover';
    return done(null, s0.brief);
  }
  if (s.status === 'asked') {
    if (isYes(text)) {
      s.status = 'active'; s.next = { day: day + 2, key: s.bucket };
      actions.push({ type: 'text', body: 'Thank you {name}, you are subscribed. You can reply STOP at any time.' });
      return done('active', 'Gave permission on ' + dayLabel(opts, day) + ' — updates started');
    }
    if (isNo(text)) { s.status = 'declined'; s.next = null; return done('declined', 'Declined updates on ' + dayLabel(opts, day)); }
    return handover('answered the permission request with something other than YES or NO',
      isCall(text) ? 'Asked for a call' : 'Answered the permission request “' + clip(text) + '”');
  }
  const digit = String(text).trim();
  if (s.lastTpl === 'ask' && /^[1-4]$/.test(digit)) {
    if (digit === '1') { s.next = { day: day + 2, key: 'price' }; actions.push({ type: 'text', body: 'Thanks {name}, I will send you some finance options.' }); s.status = 'active'; return done('active', 'Price — finance options due ' + dayLabel(opts, s.next.day)); }
    if (digit === '2') { s.next = { day: Math.max(day + 1, 30), key: 'monthly' }; actions.push({ type: 'text', body: 'No problem {name}. We will check back next month.' }); s.status = 'active'; return done('active', 'Timing — parked until ' + dayLabel(opts, s.next.day)); }
    if (digit === '3') { s.next = { day: day + 2, key: 'competitor' }; actions.push({ type: 'text', body: 'Thanks for telling us, {name}.' }); s.status = 'active'; return done('active', 'Bought another car — after-sales offer due ' + dayLabel(opts, s.next.day)); }
    return handover('answered 4, something else', 'Something else (answered 4)');
  }
  return handover('free-text reply needs a person', isCall(text) ? 'Asked for a call' : 'Replied “' + clip(text) + '”');
}

module.exports = { start, isDue, deferTo, onListed, afterFailed, afterTemplate, onReply, BUCKET_NAME, ACTIVE };
