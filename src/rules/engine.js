'use strict';
// The engine's run() without the page: cleans, dedupes, excludes, buckets,
// splits holdout and picks the Day-0 template. Ported from lost-lead-engine/index.html.
const { cleanMobile, parseDate, hashPct, addDays } = require('./mobile');
const { norm, cleanText } = require('./keywords');
const { classify, cleanBrand, cleanModel, bucketById, BUCKETS } = require('./buckets');
const T = require('./templates');

const FIELDS = [
  { key: 'mobile', label: 'Mobile', req: true, kw: ['mobile', 'phone', 'whatsapp', 'contact no', 'contact number', 'tel', 'gsm', 'cell'] },
  { key: 'name', label: 'Customer', kw: ['customer name', 'custname', 'cust name', 'name', 'customer', 'client', 'first name'], not: ['user', 'company', 'sales', 'exec'] },
  { key: 'brand', label: 'Brand', kw: ['brand', 'make', 'franchise', 'division', 'showroom'] },
  { key: 'model', label: 'Model', kw: ['model', 'vehicle', 'car', 'variant', 'interest'] },
  { key: 'reason', label: 'Loss reason', req: true, kw: ['lost reason', 'loss reason', 'reason', 'lost type', 'lost category', 'outcome'] },
  { key: 'comments', label: 'Comments', kw: ['comment', 'remark', 'note', 'feedback', 'description'] },
  { key: 'status', label: 'Status', kw: ['status', 'stage', 'lead status', 'result', 'desc'] },
  { key: 'date', label: 'Lead date', kw: ['credate', 'created', 'enquiry date', 'inquiry date', 'lead date', 'date'] },
  { key: 'sales', label: 'Salesperson', kw: ['sales', 'consultant', 'executive', 'owner', 'advisor', 'assigned', 'user name'] }
];
const JOIN = ' + ';
const EX_LABEL = { invalid: 'Invalid or non-Bahrain mobile', dup: 'Duplicate of another row', transfer: 'Quotation transferred (actually bought)', junk: 'Wrong number or junk lead', open: 'Open deal in CRM', optout: 'Opted out (replied STOP)', list: 'On do-not-contact list',
  declined: 'Opted out or said no before (history)', recent: 'Contacted recently (history)' };

function detect(headers) {
  const map = {}, used = new Set();
  FIELDS.forEach(f => {
    let best = null, score = 0;
    headers.forEach(h => {
      if (used.has(h)) return; const n = norm(h);
      if (f.not && f.not.some(x => n.includes(x))) return;
      f.kw.forEach((k, i) => { const s = n === k ? 100 - i : n.includes(k) ? 50 - i : 0; if (s > score) { score = s; best = h; } });
    });
    if (best) { map[f.key] = best; used.add(best); }
  });
  /* CRM exports that keep the reason as a free-text note split over Notes1, Notes2, Notes3
     (too long for one field): the reason is all of them, joined. */
  const notes = headers.filter(h => /^notes?\s*\d*$/i.test(String(h).trim()));
  if (!map.reason && notes.length) {
    map.reason = notes.join(JOIN);
    if (map.comments && (notes.includes(map.comments) || /description/i.test(map.comments))) delete map.comments;
  }
  return map;
}
/** Column guessing from contents, for files with no header row. */
function detectByContent(rows, headers) {
  const sample = rows.slice(0, 400), map = {}, used = new Set();
  const share = (h, t) => { let n = 0, c = 0; sample.forEach(r => { const v = r[h]; if (v === '' || v == null) return; c++; if (t(v)) n++; }); return c ? n / sample.length : 0; };
  const avgLen = h => { let s = 0, c = 0; sample.forEach(r => { const v = cleanText(r[h]); if (v) { s += v.length; c++; } }); return c ? s / c : 0; };
  const pick = (key, t, min) => { let best = null, sc = min; headers.forEach(h => { if (used.has(h)) return; const x = t(h); if (x > sc) { sc = x; best = h; } }); if (best) { map[key] = best; used.add(best); } };
  pick('mobile', h => share(h, v => !!cleanMobile(v)), 0.5);
  pick('brand', h => share(h, v => /^K\d{2}$/i.test(cleanText(v))), 0.5);
  pick('model', h => share(h, v => /^[A-Z]\//i.test(cleanText(v))), 0.2);
  pick('name', h => share(h, v => /^(mr|mrs|ms|miss|dr|sayed|sh)\b\.?/i.test(cleanText(v))), 0.3);
  pick('reason', h => share(h, v => /^lost/i.test(cleanText(v))), 0.5);
  pick('date', h => share(h, v => v instanceof Date || /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(cleanText(v))), 0.5);
  pick('comments', h => share(h, v => /[a-z]{3,}\s+[a-z]{2,}/i.test(cleanText(v))) > 0.3 ? avgLen(h) : 0, 12);
  pick('sales', h => share(h, v => /^[a-z]+(\s[a-z]+){1,2}$/i.test(cleanText(v))), 0.6);
  return map;
}

/**
 * @param rows   objects keyed by column header
 * @param map    {mobile, reason, ...} -> header
 * @param opts   {holdPct, seed, start (yyyy-mm-dd), consentFrom (yyyy-mm-dd|null),
 *                optouts (Set|Map), exclude (Set), history (Map mobile->{status,lastAt}), recentDays, now (ms)}
 */
function runEngine(rows, map, opts = {}) {
  const holdPct = Math.max(0, Math.min(50, +opts.holdPct || 0));
  const seed = +opts.seed || 0;
  const start = opts.start || new Date(opts.now || Date.now()).toISOString().slice(0, 10);
  const consentFrom = opts.consentFrom ? new Date(opts.consentFrom + 'T00:00:00Z') : null;
  const recentDays = Math.max(0, Math.min(365, Math.floor(+opts.recentDays || 0)));
  const cutoff = recentDays ? (opts.now || Date.now()) - recentDays * 864e5 : null;
  const optouts = opts.optouts || new Set(), exclude = opts.exclude || new Set(), history = opts.history || new Map();
  /* a mapping may join several columns: 'Notes1 + Notes2 + Notes3' */
  const get = (row, k) => {
    const h = map[k]; if (!h) return '';
    if (h in row || !h.includes(JOIN)) return row[h];
    return h.split(JOIN).map(x => row[x]).filter(v => v !== '' && v != null).map(v => cleanText(v)).join(' ');
  };

  const leads = rows.map((row, i) => ({
    i, mobileRaw: get(row, 'mobile'), mobile: cleanMobile(get(row, 'mobile')), name: cleanText(get(row, 'name')),
    brand: cleanBrand(get(row, 'brand')) || cleanText(opts.defaultBrand), model: cleanModel(get(row, 'model')),
    reason: cleanText(get(row, 'reason')), comments: cleanText(get(row, 'comments')),
    status: cleanText(get(row, 'status')), date: parseDate(get(row, 'date')), sales: cleanText(get(row, 'sales'))
  }));

  // dedupe by mobile: keep the most recent row
  const byMobile = new Map();
  leads.forEach(l => {
    if (!l.mobile) return; const p = byMobile.get(l.mobile);
    if (!p || ((l.date ? l.date.getTime() : 0) >= (p.date ? p.date.getTime() : 0))) byMobile.set(l.mobile, l);
  });

  const out = { total: leads.length, unique: byMobile.size, send: [], hold: [], meta: [], metaHold: [], excluded: [], exCount: {}, bucketCount: {} };
  Object.keys(EX_LABEL).forEach(k => out.exCount[k] = 0);
  BUCKETS.forEach(b => out.bucketCount[b.id] = { send: 0, hold: 0 });
  const excludeLead = (l, why) => { l.exReason = why; out.excluded.push(l); out.exCount[why]++; };

  leads.forEach(l => {
    if (!l.mobile) return excludeLead(l, 'invalid');
    if (byMobile.get(l.mobile) !== l) return excludeLead(l, 'dup');
    if (optouts.has(l.mobile)) return excludeLead(l, 'optout');
    if (exclude.has(l.mobile)) return excludeLead(l, 'list');
    const h = history.get(l.mobile);
    if (h && (h.status === 'optout' || h.status === 'declined')) return excludeLead(l, 'declined');
    if (h && cutoff && h.lastAt && Date.parse(h.lastAt) >= cutoff) return excludeLead(l, 'recent');
    const c = classify(l);
    if (c.ex) return excludeLead(l, c.ex);
    l.bucket = c.bucket;
    l.track = (consentFrom && (!l.date || l.date < consentFrom)) ? 'permission' : 'standard';
    l.group = hashPct(l.mobile, seed) < holdPct ? 'holdout' : 'send';
    const b = bucketById(l.bucket);
    if (b.ch === 'meta') { (l.group === 'send' ? out.meta : out.metaHold).push(l); }
    else {
      const tpl = T.templateForKey(l.track === 'permission' ? 'permission' : l.bucket);
      l.tplName = tpl.name;
      l.vars = l.group === 'send' ? T.varValues(tpl.body.en, l) : [];
      l.message = l.group === 'send' ? T.fill(tpl.body.en, l) : '';
      l.day0 = start; l.day2 = addDays(start, 2); l.day7 = addDays(start, 7); l.day30 = addDays(start, 30);
      (l.group === 'send' ? out.send : out.hold).push(l);
    }
    out.bucketCount[l.bucket][l.group === 'send' ? 'send' : 'hold']++;
  });
  return out;
}

/* ---------- sample data (fictional), identical to the engine's ---------- */
function sampleRows() {
  const brands = [['SOUEAST', 'S07'], ['SOUEAST', 'S08'], ['SOUEAST', 'S06'], ['ZEEKR', '7X'], ['ZEEKR', '001'], ['JMC', 'Vigus'], ['JMC', 'Grand Avenue'], ['212', 'T01'], ['Kaiyi', 'X3 Pro']];
  const names = ['Ali', 'Fatima', 'Hassan', 'Maryam', 'Yusuf', 'Noora', 'Khalid', 'Zainab', 'Ahmed', 'Sara', 'Omar', 'Layla', 'Ebrahim', 'Huda', 'Mohamed', 'Reem', 'Jassim', 'Aisha', 'Salman', 'Dana'];
  const reasons = [
    ['Price too high', ''], ['Finance rejected by bank', ''], ['Trade-in value not acceptable', ''], ['Budget', 'Customer comparing monthly installment'],
    ['Waiting for stock', 'Wants white colour, not available'], ['Still thinking', 'Will decide next year'], ['Postponed', ''],
    ['Bought another brand', 'Went with Toyota'], ['Bought used car', ''], ['Lack of product features', 'Needs 7 seats'],
    ['Family rejection', 'Wife prefers bigger car'], ['Customer stopped responding', 'No answer after 3 calls'], ['', ''], ['', ''], ['Other', ''],
    ['Disqualified', 'Just browsing'], ['Not interested', ''], ['Quotation transferred', "New quotation under father's name"], ['Wrong number', ''], ['Lost', 'Customer not reachable, phone switched off']
  ];
  const sales = ['S. Kumar', 'R. Fernandes', 'A. Rahman', 'M. Saleh'];
  const rows = []; let seed = 7;
  const rnd = n => { seed = (seed * 9301 + 49297) % 233280; return Math.floor(seed / 233280 * n); };
  for (let i = 0; i < 160; i++) {
    const b = brands[rnd(brands.length)], r = reasons[rnd(reasons.length)];
    let mob = '3999' + String(1000 + i).slice(-4);
    if (i % 23 === 5) mob = '1729' + String(1000 + i).slice(-4);       // landline -> invalid
    if (i % 31 === 7) mob = '3999' + String(1000 + i - 1).slice(-4);   // duplicate
    const d = new Date(Date.UTC(2026, rnd(10), 1 + rnd(27)));
    rows.push({ 'Customer Name': names[rnd(names.length)] + ' (sample)', 'Mobile No': (i % 3 ? '973' : '') + mob, 'Brand': b[0], 'Model Interested': b[1],
      'Lost Reason': r[0], 'Remarks': r[1], 'Lead Status': r[0] === 'Disqualified' ? 'Disqualified' : 'Lost', 'Created Date': d, 'Sales Consultant': sales[rnd(sales.length)] });
  }
  return rows;
}

module.exports = { FIELDS, EX_LABEL, JOIN, detect, detectByContent, runEngine, sampleRows };
