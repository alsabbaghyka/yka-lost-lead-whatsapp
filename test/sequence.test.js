'use strict';
// The simulator's 13 demo customers, replayed through the server's sequence
// rules with a pure day-by-day driver, must pass the simulator's 9 checks.
// Each injected fault must make its check fail, or the check proves nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/rules/sequence');
const { isStop } = require('../src/rules/replies');

const SEED = [
  { name: 'Ali', bucket: 'price', script: { 1: { text: 'Yes please send me the options' } } },
  { name: 'Fatima', bucket: 'stock', script: { 1: { text: 'STOP' } } },
  { name: 'Hassan', bucket: 'thinking', script: {} },
  { name: 'Maryam', bucket: 'competitor', script: { 3: { text: 'Interested, what is the offer?' } } },
  { name: 'Yusuf', bucket: 'ask', script: { 1: { text: '2', wait: 1 } } },
  { name: 'Noora', bucket: 'ask', script: { 1: { text: '1' }, 2: { text: 'ok call me tomorrow' } } },
  { name: 'Khalid', bucket: 'family', script: { 1: { text: 'توقف' } } },
  { name: 'Zainab', bucket: 'features', script: { 1: { text: 'Who gave you my number?' } } },
  { name: 'Ahmed', bucket: 'stock', track: 'permission', script: { 1: { text: 'YES' } } },
  { name: 'Sara', bucket: 'price', track: 'permission', script: {} },
  { name: 'Omar', bucket: 'thinking', group: 'holdout', script: {} },
  { name: 'Layla', bucket: 'price', fail: true, script: {} },
  { name: 'Dana', bucket: 'ask', script: { 1: { text: 'I stopped by the showroom yesterday, still interested' } } },
  { name: 'Listed', bucket: 'price', listedFrom: 3, script: {} }   // put on the opt-out list on day 3
];
const DAY0 = Date.UTC(2026, 11, 2); // Wed 2 Dec 2026, so Day 2 nudges fall on a Friday
const isFri = d => new Date(DAY0 + d * 864e5).getUTCDay() === 5;

function simulate(fault = '') {
  const cust = SEED.map((p, id) => ({ id, p, msgs: [], pending: [], s: Q.start({ track: p.track || 'standard', bucket: p.bucket, group: p.group || 'send' }) }));
  const send = (c, key, day) => {
    if (c.p.fail) { c.msgs.push({ dir: 'out', tpl: key, day }); c.s = Q.afterFailed(c.s); return; }
    c.msgs.push({ dir: 'out', tpl: key, day });
    c.s = Q.afterTemplate(c.s, key, day).state;
    const r = c.p.script[c.s.tplCount];
    if (r) c.pending.push({ day: day + (r.wait || 0), text: r.text });
  };
  for (let day = 0; day <= 60; day++) {
    for (const c of cust) {
      if (c.s.group === 'holdout') { if (fault === 'hold' && day === 0) send(c, c.s.bucket, day); continue; }
      const listed = c.p.listedFrom != null && day >= c.p.listedFrom;
      if (Q.isDue(c.s, day, fault === 'hand')) {
        if (listed && fault !== 'list') { c.s = Q.onListed(c.s); continue; }
        if (isFri(day) && fault !== 'friday') { c.s = Q.deferTo(c.s, day + 1); continue; }
        send(c, c.s.next.key, day);
      }
    }
    for (const c of cust) {
      const due = c.pending.filter(x => x.day <= day); c.pending = c.pending.filter(x => x.day > day);
      for (const x of due) {
        c.msgs.push({ dir: 'in', text: x.text, day });
        if (fault === 'stop' && isStop(x.text)) continue;
        const r = Q.onReply(c.s, x.text, day, { keepSequenceOnHandover: fault === 'hand' });
        c.s = r.state;
        if (r.actions.some(a => a.type === 'optout')) c.optAt = c.msgs.length;
        if (r.actions.some(a => a.type === 'handover')) c.handAt = c.msgs.length;
        r.actions.filter(a => a.type === 'text').forEach(a => c.msgs.push({ dir: 'out', text: a.body, day }));
      }
    }
  }
  return cust;
}

function checks(cust) {
  const out = c => c.msgs.filter(m => m.dir === 'out');
  const tpls = c => out(c).filter(m => m.tpl);
  const bad = fn => cust.filter(fn).map(c => c.p.name);
  const maxRun = c => { let run = 0, max = 0; c.msgs.forEach(m => { if (m.dir === 'in') run = 0; else if (m.tpl) { run++; max = Math.max(max, run); } }); return max; };
  return {
    afterOptout: bad(c => c.optAt != null && c.msgs.slice(c.optAt).filter(m => m.dir === 'out').length > 1),
    stopOptsOut: bad(c => c.s.status !== 'optout' && c.msgs.some(m => m.dir === 'in' && isStop(m.text))),
    holdout: bad(c => c.s.group === 'holdout' && tpls(c).length > 0),
    handoverPause: bad(c => c.handAt != null && c.msgs.slice(c.handAt).filter(m => m.dir === 'out' && m.tpl).length > 0),
    threeUnanswered: bad(c => maxRun(c) > 3),
    permissionFirst: bad(c => (c.p.track === 'permission') && tpls(c).length && tpls(c)[0].tpl !== 'permission'),
    noRetryUndeliverable: bad(c => c.p.fail && out(c).length > 1),
    noFriday: bad(c => tpls(c).some(m => isFri(m.day))),
    listNotMessaged: bad(c => c.p.listedFrom != null && tpls(c).some(m => m.day >= c.p.listedFrom))
  };
}

test('the 9 simulator checks all pass on the demo cast', () => {
  const r = checks(simulate());
  for (const [k, v] of Object.entries(r)) assert.deepEqual(v, [], k);
});
test('each injected fault is caught by its check', () => {
  assert.deepEqual(checks(simulate('stop')).stopOptsOut, ['Fatima', 'Khalid']);
  assert.deepEqual(checks(simulate('hold')).holdout, ['Omar']);
  assert.ok(checks(simulate('hand')).handoverPause.length > 0);
  assert.deepEqual(checks(simulate('list')).listNotMessaged, ['Listed']);
  assert.ok(checks(simulate('friday')).noFriday.length > 0);
});
test('the demo cast ends where the simulator says it does', () => {
  const by = Object.fromEntries(simulate().map(c => [c.p.name, c.s]));
  assert.equal(by.Ali.status, 'handover');
  assert.equal(by.Fatima.status, 'optout');
  assert.equal(by.Hassan.status, 'quiet');
  assert.equal(by.Hassan.tplCount, 3, 'Day 0, Day 2 nudge, Day 7 voucher, then stop');
  assert.equal(by.Maryam.status, 'handover');
  assert.equal(by.Yusuf.status, 'active');
  assert.equal(by.Noora.status, 'handover');
  assert.equal(by.Khalid.status, 'optout');
  assert.equal(by.Zainab.status, 'handover');
  assert.equal(by.Ahmed.status, 'quiet', 'YES starts the stock sequence, which then goes unanswered');
  assert.equal(by.Sara.status, 'asked');
  assert.equal(by.Omar.status, 'holdout');
  assert.equal(by.Layla.status, 'failed');
  assert.equal(by.Dana.status, 'handover', '"stopped by" is not STOP: a person picks it up');
  assert.equal(by.Listed.status, 'listed');
});
test('sequence days: nudge +2, voucher on day 7, monthly on day 30', () => {
  let s = Q.start({ track: 'standard', bucket: 'price', group: 'send' });
  assert.deepEqual(s.next, { day: 0, key: 'price' });
  s = Q.afterTemplate(s, 'price', 0).state; assert.deepEqual(s.next, { day: 2, key: 'nudge' });
  s = Q.afterTemplate(s, 'nudge', 2).state; assert.deepEqual(s.next, { day: 7, key: 'voucher' });
  s = Q.onReply(s, 'maybe', 3).state; // a reply resets the unanswered count but hands over
  assert.equal(s.status, 'handover');
});
test('reason answers 1-4 to the ask-reason template', () => {
  const asked = () => Q.afterTemplate(Q.start({ track: 'standard', bucket: 'ask', group: 'send' }), 'ask', 0).state;
  assert.deepEqual(Q.onReply(asked(), '1', 1).state.next, { day: 3, key: 'price' });
  assert.deepEqual(Q.onReply(asked(), '2', 1).state.next, { day: 30, key: 'monthly' });
  assert.deepEqual(Q.onReply(asked(), '3', 1).state.next, { day: 3, key: 'competitor' });
  assert.equal(Q.onReply(asked(), '4', 1).state.status, 'handover');
  assert.equal(Q.onReply(asked(), ' 1 ', 1).state.next.key, 'price');
});
test('permission: YES starts the bucket message, NO declines, other text hands over', () => {
  const asked = () => Q.afterTemplate(Q.start({ track: 'permission', bucket: 'stock', group: 'send' }), 'permission', 0).state;
  const yes = Q.onReply(asked(), 'Yes', 1);
  assert.equal(yes.state.status, 'active'); assert.deepEqual(yes.state.next, { day: 3, key: 'stock' });
  assert.match(yes.actions.find(a => a.type === 'text').body, /subscribed/);
  const no = Q.onReply(asked(), 'no thanks', 1);
  assert.equal(no.state.status, 'declined'); assert.equal(no.state.next, null);
  assert.equal(Q.onReply(asked(), 'what offers?', 1).state.status, 'handover');
});
test('STOP after a handover still opts out; replies after an opt-out do nothing', () => {
  let s = Q.afterTemplate(Q.start({ track: 'standard', bucket: 'price', group: 'send' }), 'price', 0).state;
  s = Q.onReply(s, 'tell me more', 1).state; assert.equal(s.status, 'handover');
  const r = Q.onReply(s, 'stop', 2); assert.equal(r.state.status, 'optout'); assert.ok(r.actions.some(a => a.type === 'optout'));
  const after = Q.onReply(r.state, 'hello?', 3); assert.equal(after.actions.length, 0);
});
test('an unsubscribe quick-reply button is an opt-out', () => {
  const s = Q.afterTemplate(Q.start({ track: 'standard', bucket: 'price', group: 'send' }), 'price', 0).state;
  assert.equal(Q.onReply(s, 'Unsubscribe', 1).state.status, 'optout');
});
