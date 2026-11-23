'use strict';
// Ported verbatim from lost-lead-engine/index.html: the 9 buckets, match order,
// exclusion keyword lists and classify(). Change wording here, not in callers.
const { norm, cleanText, has } = require('./keywords');

const BUCKETS = [
  { id: 'price', name: 'Price or finance', desc: 'Too expensive, budget, finance or bank rejection, trade-in value', ch: 'wa', tplName: 'lost_lead_price_v1',
    kw: ['price', 'expensive', 'budget', 'afford*', 'cost', 'financ*', 'bank', 'loan', 'reject*', 'down payment', 'down pay', 'dp', 'emi', 'installment', 'salary', 'eligib*', 'approval', 'trade', 'trade-in', 'valuation', 'سعر', 'غالي', 'تمويل', 'leasing', 'saving*', 'situation', 'suffering', 'without cheque', 'without check'] },
  { id: 'stock', name: 'Waiting for stock', desc: 'Colour, variant or delivery not available', ch: 'wa', tplName: 'lost_lead_stock_v1',
    kw: ['stock', 'availab*', 'waiting', 'delivery', 'colour', 'color', 'not in stock', 'arrival'] },
  { id: 'thinking', name: 'Still thinking', desc: 'Postponed, decide later, next year', ch: 'wa', tplName: 'lost_lead_thinking_v1',
    kw: ['thinking', 'think', 'later', 'future', 'postpon*', 'postph*', 'next year', 'not now', 'decide', 'decided', 'undecided', 'not planning', 'need time', 'needs time', 'some time', 'finalis*', 'finaliz*', 'deferred', 'on hold', 'hold purchase', 'no plan', 'not required now', 'no need now', 'will call', 'come back', 'come ba*', 'call back', 'not needed', 'if anything'] },
  { id: 'competitor', name: 'Bought elsewhere', desc: 'Another brand, competitor, used car', ch: 'wa', tplName: 'lost_lead_aftersales_v1',
    kw: ['another brand', 'other brand', 'competitor', 'bought', 'purchased', 'used car', 'pre-owned', 'preowned', 'second hand', 'second-hand', 'reserve another', 'other dealer', 'offred', 'offered', 'toyota', 'hyundai', 'kia', 'mg', 'chery', 'geely', 'haval', 'jetour', 'changan', 'jac', 'bestu*', 'byd', 'tank', 'biugh*', 'biught', 'alameed', 'deal done via', 'sold by', 'already to someone', 'alreadyto someone'] },
  { id: 'features', name: "Product didn't fit", desc: 'Size, features, fuel, warranty, resale', ch: 'wa', tplName: 'lost_lead_alternative_v1',
    kw: ['feature', 'spec*', 'size', 'space', 'seat', 'small', 'big', 'fuel', 'engine', 'power', 'performance', 'did not like', "didn't like", 'warranty', 'resale', 'model not', 'design', 'interior', 'electric', 'hybrid', 'vibration', 'noise', 'not happy with', 'full option'] },
  { id: 'family', name: 'Family said no', desc: 'Spouse, parents or family decision', ch: 'wa', tplName: 'lost_lead_family_v1',
    kw: ['family', 'wife', 'husband', 'father', 'mother', 'parent', 'spouse'] },
  { id: 'noresp', name: 'Stopped responding', desc: 'No answer, unreachable, phone off', ch: 'wa', tplName: 'lost_lead_ask_reason_v1',
    kw: ['no response', 'not respond*', 'not answer*', 'no answer', 'not reply', 'no reply', 'never repl*', 'replied at all', 'unreachable', 'switched off', 'not reachable', 'stopped respond*', 'busy', "didn't respond", 'did not respond', 'switch off', 'no whatsapp'] },
  { id: 'noreason', name: 'No reason recorded', desc: 'Blank or unclear loss reason', ch: 'wa', kw: [], tplName: 'lost_lead_ask_reason_v1' },
  { id: 'disq', name: 'Disqualified', desc: 'Not interested now; goes to Meta ads, not WhatsApp', ch: 'meta', tplName: '',
    kw: ['disqualif*', 'not interested', 'no interest', 'just checking', 'just browsing', 'enquiry only', 'inquiry only', 'didnt inquire', 'did not inquire', "didn't inquire", 'didnt enquire', 'did not enquire'] }
];
/* strongest signal first: someone who bought elsewhere is not "waiting for stock" */
const MATCH_ORDER = ['competitor', 'price', 'noresp', 'features', 'family', 'thinking', 'stock'];
const TRANSFER_KW = ['transfer*', 'name change', 'changed name', 'quotation chang*', 'quote chang*', 'another name', 'new quotation', 'hire purchase', 'nfh', 're-quoted', 'requoted', 'under company', 'family member name', 'transff*', 'under sister', 'under brother', 'under wife', 'sister name', 'brother name'];
const JUNK_KW = ['wrong number', 'invalid', 'junk', 'spam', 'test lead', 'by mistake', 'fake', 'duplicate lead', 'ksa customer', 'saudi customer', 'not in bahrain', 'outside bahrain', 'looking for export', 'for export', 'out of bahrain', 'not in service', 'checking our'];
const OPEN_KW = ['open', 'in progress', 'follow*', 'hot', 'warm', 'booked', 'negotiat*', 'pending', 'quotation sent', 'test drive scheduled'];
/* "bought from us" is our own sale, not a competitor's */
const OURS_KW = ['from us', 'with us', 'by us', 'from yk', 'from y.k', 'from ykas', 'our showroom', 'from almoayyed', 'from al moayyed'];
/* phrases in comments that mean another salesperson still has the deal */
const OPEN_TEXT_KW = ['is following up', 'still following', 'following up with', 'booking done', 'deposit paid', 'paid deposit', 'make new quote', 'new quote'];
/* system-generated text that carries no real reason */
const SYSTEM_TEXT = [/marked as lost sal?e?/i, /most sale/i, /^_?x000d_?/i, /enquiry \d+/i, /^old quote$/i, /^lost sale$/i, /^lost sale - \(reason\)$/i, /^lost$/i, /^nothing new$/i];
/* Y.K. Almoayyed SLR franchise codes */
const BRAND_CODES = { K38: 'JMC', K48: 'SOUEAST', K58: 'ZEEKR', K69: '212', K88: 'Kaiyi' };

function cleanBrand(v) { const s = cleanText(v); return BRAND_CODES[s.toUpperCase()] || s; }
function cleanModel(v) { return cleanText(v).replace(/^[A-Z]\//i, '').trim(); }
function meaningful(text) { const t = cleanText(text); if (!t) return ''; return SYSTEM_TEXT.some(rx => rx.test(t)) ? '' : t; }
const bucketById = id => BUCKETS.find(b => b.id === id);
const DISQ_KW = bucketById('disq').kw;

/** {ex: reason} for an excluded lead, or {bucket: id}. */
function classify(r) {
  const reasonM = norm(meaningful(r.reason)), commentM = norm(meaningful(r.comments));
  const text = (reasonM + ' ' + commentM).trim();
  const st = norm(r.status), rs = norm(r.reason);
  if (has(text, TRANSFER_KW)) return { ex: 'transfer' };
  if (has(text, JUNK_KW)) return { ex: 'junk' };
  if (has(commentM, OPEN_TEXT_KW)) return { ex: 'open' };
  if (st && has(st, OPEN_KW) && !st.includes('lost') && !st.includes('closed') && !st.includes('disqual')) return { ex: 'open' };
  if (rs && has(rs, ['follow up', 'follow-up']) && !rs.includes('lost')) return { ex: 'open' };
  /* Disqualified is a judgement about the lead, so read it from the status or
     the loss reason only: "not interested in the white colour" is a remark about the car. */
  if (st.includes('disqual') || has(reasonM, DISQ_KW)) return { bucket: 'disq' };
  if (!text) return { bucket: 'noreason' };
  const ours = has(text, OURS_KW);
  for (const id of MATCH_ORDER) {
    if (id === 'competitor' && ours) continue;
    if (has(text, bucketById(id).kw)) return { bucket: id };
  }
  return { bucket: 'noreason' };
}

module.exports = { BUCKETS, MATCH_ORDER, TRANSFER_KW, JUNK_KW, OPEN_KW, OURS_KW, OPEN_TEXT_KW, SYSTEM_TEXT, BRAND_CODES,
  cleanBrand, cleanModel, meaningful, classify, bucketById };
