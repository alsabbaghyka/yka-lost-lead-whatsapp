'use strict';
// Rules ported from lost-lead-engine/index.html. Each probe below is a case
// the engine was tuned on; the server must give the same answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanMobile, mobileOf, parseDate, hashPct } = require('../src/rules/mobile');
const { has, hasKw } = require('../src/rules/keywords');
const { classify, BUCKETS } = require('../src/rules/buckets');
const T = require('../src/rules/templates');
const { runEngine, sampleRows, detect, FIELDS } = require('../src/rules/engine');
const S = require('../src/rules/stats');
const R = require('../src/rules/replies');

test('cleanMobile accepts Bahrain mobiles in every common shape', () => {
  assert.equal(cleanMobile('39991000'), '+97339991000');
  assert.equal(cleanMobile('97339991000'), '+97339991000');
  assert.equal(cleanMobile('0097366001234'), '+97366001234');
  assert.equal(cleanMobile('+973 3999 1000'), '+97339991000');
  assert.equal(cleanMobile(39991000.0), '+97339991000');
  assert.equal(cleanMobile('39991000.0'), '+97339991000');
});
test('cleanMobile rejects landlines, short numbers and other countries', () => {
  assert.equal(cleanMobile('17291000'), null);
  assert.equal(cleanMobile('3999100'), null);
  assert.equal(cleanMobile('966501234567'), null);
  assert.equal(cleanMobile(''), null);
  assert.equal(cleanMobile(null), null);
});
test('a date-shaped value is never a mobile', () => {
  assert.equal(cleanMobile('30/06/2026'), '+97330062026'); // the trap mobileOf exists for
  assert.equal(mobileOf('30/06/2026'), null);
  assert.equal(mobileOf('2026-06-30'), null);
  assert.equal(mobileOf(new Date()), null);
  assert.equal(mobileOf('39991000'), '+97339991000');
});
test('parseDate reads day-first text and Excel serials', () => {
  assert.equal(parseDate('05/03/2026').toISOString().slice(0, 10), '2026-03-05');
  assert.equal(parseDate(46000).toISOString().slice(0, 10), '2025-12-09');
  assert.equal(parseDate(''), null);
});
test('hashPct matches the engine exactly', () => {
  assert.equal(hashPct('+97339991000', 2026), 29.9);
  assert.equal(hashPct('+97336001234', 2026), 59.8);
  assert.equal(hashPct('+97339991000', 0), 46.44);
});

test('keywords match whole words only', () => {
  assert.equal(hasKw('customer is busy', 'busy'), true);
  assert.equal(hasKw('business customer', 'busy'), false);
  assert.equal(hasKw('bought a jac', 'jac'), true);
  assert.equal(hasKw('wants a jacket', 'jac'), false);
  assert.equal(hasKw('dp too high', 'dp'), true);
  assert.equal(hasKw('dpt approved', 'dp'), false);
  assert.equal(hasKw('two banks rejected', 'bank'), true, 'plural s');
});
test('a trailing * is a stem', () => {
  assert.equal(hasKw('not available in white', 'availab*'), true);
  assert.equal(hasKw('availability issue', 'availab*'), true);
  assert.equal(hasKw('postponed to next year', 'postpon*'), true);
});
test('Arabic keywords match as substrings', () => {
  assert.equal(has('السعر مرتفع', ['سعر']), true);
  assert.equal(has('غالي جدا', ['غالي']), true);
  assert.equal(classify({ reason: 'السعر غالي', comments: '', status: 'Lost' }).bucket, 'price');
  assert.equal(classify({ reason: 'تمويل مرفوض', comments: '', status: 'Lost' }).bucket, 'price');
});

test('classify: the probe cases', () => {
  const c = (reason, comments = '', status = 'Lost') => classify({ reason, comments, status });
  assert.equal(c('Waiting for stock', 'not interested in the white colour').bucket, 'stock', 'a remark about the car is not a disqualification');
  assert.equal(c('Not interested').bucket, 'disq');
  assert.equal(c('Other', '', 'Disqualified').bucket, 'disq');
  assert.equal(c('Bought', 'bought from us last week').bucket === 'competitor', false, 'bought from us is ours');
  assert.equal(c('Bought another brand', 'Went with Toyota').bucket, 'competitor');
  assert.equal(c('Customer busy', '').bucket, 'noresp');
  assert.equal(c('Business purchase', '').bucket, 'noreason');
  assert.equal(c('', '').bucket, 'noreason');
  assert.equal(c('Lost', '').bucket, 'noreason', 'system text carries no reason');
  assert.equal(c('Bought another brand', 'Toyota cheaper price').bucket, 'competitor', 'competitor beats price');
});
test('classify: exclusions come before buckets', () => {
  const c = (reason, comments = '', status = 'Lost') => classify({ reason, comments, status });
  assert.equal(c('Quotation transferred', "New quotation under father's name").ex, 'transfer');
  assert.equal(c('Wrong number').ex, 'junk');
  assert.equal(c('Price', 'Ahmed is following up').ex, 'open');
  assert.equal(c('Price', '', 'Open').ex, 'open');
  assert.equal(c('Follow up', '', '').ex, 'open');
  assert.equal(c('Price', '', 'Lost - closed').ex, undefined);
});
test('there are 9 buckets and the WhatsApp ones have templates', () => {
  assert.deepEqual(BUCKETS.map(b => b.id), ['price', 'stock', 'thinking', 'competitor', 'features', 'family', 'noresp', 'noreason', 'disq']);
  BUCKETS.filter(b => b.ch === 'wa').forEach(b => assert.match(b.tplName, /^lost_lead_\w+_v1$/));
});

test('templates: numbered variables in order of first use', () => {
  const t = 'Hi {name}, thanks for your interest in the {model} at {brand}. {name}?';
  assert.deepEqual(T.tplVars(t), ['name', 'model', 'brand']);
  assert.equal(T.tplBody(t), 'Hi {{1}}, thanks for your interest in the {{2}} at {{3}}. {{1}}?');
  assert.deepEqual(T.varValues(t, { name: 'Mr. ali hassan', model: '', brand: 'ZEEKR' }), ['Ali', 'car you asked about', 'ZEEKR']);
  assert.equal(T.firstName('123 abc'), 'there');
});
test('templates: catalogue has 8 Day-0 templates plus 3 drafts, English and Arabic', () => {
  const day0 = T.CATALOGUE.filter(t => !t.draft);
  assert.equal(new Set(day0.map(t => t.name)).size, 8);
  assert.equal(T.CATALOGUE.filter(t => t.draft).length, 3);
  T.CATALOGUE.forEach(t => { assert.ok(t.body.en); assert.ok('ar' in t.body); });
  assert.equal(T.templateForKey('noresp').name, 'lost_lead_ask_reason_v1');
  assert.equal(T.templateForKey('permission').name, 'lost_lead_permission_v1');
  assert.equal(T.templateForKey('nudge').name, 'lost_lead_nudge_v1');
});

test('engine sample: 160 rows -> 148 customers, 31 excluded, 12 holdout, 11 Meta, 106 ready', () => {
  const rows = sampleRows();
  const map = detect(Object.keys(rows[0]));
  assert.equal(map.mobile, 'Mobile No');
  assert.equal(map.reason, 'Lost Reason');
  const o = runEngine(rows, map, { holdPct: 15, seed: 2026, consentFrom: '2026-11-01', start: '2026-12-01' });
  assert.equal(o.total, 160);
  assert.equal(o.unique, 148);
  assert.equal(o.excluded.length, 31);
  assert.equal(o.hold.length + o.metaHold.length, 12);
  assert.equal(o.meta.length, 11);
  assert.equal(o.send.length, 106);
  assert.ok(o.send.every(l => l.track === 'permission' && l.tplName === 'lost_lead_permission_v1'));
});
test('engine: opt-outs, do-not-contact and history exclusions', () => {
  const rows = [
    { m: '39990001', r: 'Price' }, { m: '39990002', r: 'Price' }, { m: '39990003', r: 'Price' },
    { m: '39990004', r: 'Price' }, { m: '39990005', r: 'Price' }].map(x => ({ Mobile: x.m, Reason: x.r }));
  const o = runEngine(rows, { mobile: 'Mobile', reason: 'Reason' }, {
    holdPct: 0, seed: 2026, now: Date.parse('2026-12-01'),
    optouts: new Set(['+97339990001']), exclude: new Set(['+97339990002']),
    history: new Map([['+97339990003', { status: 'declined' }], ['+97339990004', { lastAt: '2026-11-25T10:00:00Z' }]]),
    recentDays: 30 });
  assert.deepEqual(o.excluded.map(l => l.exReason), ['optout', 'list', 'declined', 'recent']);
  assert.equal(o.send.length, 1);
  assert.equal(o.send[0].track, 'standard');
  assert.equal(o.send[0].tplName, 'lost_lead_price_v1');
});
test('FIELDS keeps mobile and reason as the required columns', () => {
  assert.deepEqual(FIELDS.filter(f => f.req).map(f => f.key), ['mobile', 'reason']);
});

test('stats: two-proportion z test and interval', () => {
  const r = S.compareArms({ n: 1000, conv: 120 }, { n: 200, conv: 16 });
  assert.equal(r.p1, 0.12); assert.equal(r.p2, 0.08);
  assert.ok(Math.abs(r.z - 1.6290) < 1e-3, `z ${r.z}`);
  assert.ok(Math.abs(r.p - 0.1033) < 1e-3, `p ${r.p}`);
  assert.ok(r.lo < 0 && r.hi > 0.08);
  assert.ok(Math.abs(S.normCdf(1.96) - 0.975) < 1e-4);
});
test('stats: minimum detectable effect', () => {
  assert.equal(S.minDetectable(0, 10, 0.1), null);
  assert.ok(Math.abs(S.minDetectable(106, 12, 0.1) - 0.2558) < 1e-3);
});
test('stats: scoreArm counts within the window and undated matches', () => {
  const day0 = new Date('2026-12-01');
  const arm = new Map([['a', { day0 }], ['b', { day0 }], ['c', { day0 }], ['d', { day0 }]]);
  const out = new Map([['a', new Date('2026-12-10')], ['b', new Date('2027-06-01')], ['c', null]]);
  assert.deepEqual(S.scoreArm(arm, out, 60), { n: 4, conv: 2, undated: 1, rate: 0.5 });
});

test('replies: STOP in English and Arabic, but not "stopped by"', () => {
  assert.equal(R.isStop('STOP'), true);
  assert.equal(R.isStop('please stop'), true);
  assert.equal(R.isStop('Unsubscribe'), true);
  assert.equal(R.isStop('توقف'), true);
  assert.equal(R.isStop('إلغاء'), true);
  assert.equal(R.isStop('I stopped by the showroom yesterday, still interested'), false);
  assert.equal(R.isStop('stop by tomorrow?'), true, 'errs towards suppressing');
});
test('replies: yes / no / call', () => {
  assert.equal(R.isYes('YES'), true); assert.equal(R.isYes('ok sure'), true); assert.equal(R.isYes('نعم'), true);
  assert.equal(R.isYes('yesterday'), false);
  assert.equal(R.isNo('No thanks'), true); assert.equal(R.isNo('not interested'), true); assert.equal(R.isNo('none'), false);
  assert.equal(R.isCall('ok call me tomorrow'), true);
});
test('replies export: our own outbound rows are ignored', () => {
  const rows = [
    { Phone: '97339990001', Direction: 'inbound', Message: 'STOP' },
    { Phone: '97339990002', Direction: 'outbound', Message: 'Hi Ali ... Reply STOP to opt out.' },
    { Phone: '97339990003', Direction: '', Message: 'Hi Sara, offers... Reply STOP to opt out.' },
    { Phone: '97339990004', Direction: 'inbound', Message: 'I stopped by the showroom' },
    { Phone: '97339990005', Direction: 'inbound', Message: 'توقف' }];
  const r = R.parseOptoutRows(rows, Object.keys(rows[0]));
  assert.deepEqual(r.mobiles, ['+97339990001', '+97339990005']);
  assert.equal(r.outbound, 2);
});
test('replies export with no message column: every number is an opt-out', () => {
  const rows = [{ mobile: '+97339990001', opted_out_on: '2026-11-01' }, { mobile: '39990002', opted_out_on: '' }];
  const r = R.parseOptoutRows(rows, ['mobile', 'opted_out_on']);
  assert.deepEqual(r.mobiles, ['+97339990001', '+97339990002']);
  assert.equal(r.noText, true);
});
