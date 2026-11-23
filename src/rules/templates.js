'use strict';
// The WhatsApp template catalogue. Day-0 and permission bodies are the engine's,
// word for word (lost-lead-engine/index.html); the Day 2 / 7 / 30 bodies are the
// simulator's DRAFTS and are marked so everywhere. Arabic bodies are placeholders:
// a translator writes them and Meta approves them before any Arabic send.
const { cleanText } = require('./keywords');

const STOPLINE = '\n\nReply STOP to opt out.';
const ASK = "Hi {name}, thanks for your interest in the {model} at {brand}. Quick question: what stopped you going ahead?\n1 Price  2 Timing  3 Found another car  4 Something else" + STOPLINE;

const CATALOGUE = [
  { key: 'price', name: 'lost_lead_price_v1', category: 'MARKETING', body: { en: 'Hi {name}, thanks again for visiting {brand}. If the {model} felt outside your budget, we can show you flexible finance, lease-to-buy, or a model that fits better. Shall I send you some options?' + STOPLINE, ar: null } },
  { key: 'stock', name: 'lost_lead_stock_v1', category: 'MARKETING', body: { en: 'Hi {name}, good news from {brand}: new {model} stock is arriving. Would you like a first look or a test drive this week?' + STOPLINE, ar: null } },
  { key: 'thinking', name: 'lost_lead_thinking_v1', category: 'MARKETING', body: { en: 'Hi {name}, still thinking about the {model}? We can bring a test drive to your home or office at a time that suits you. Interested?' + STOPLINE, ar: null } },
  { key: 'competitor', name: 'lost_lead_aftersales_v1', category: 'MARKETING', body: { en: "Hi {name}, congratulations on your new car. Whatever you drive, YK Auto Mall and Quick Lane look after all makes: servicing, tint, ceramic coating and inspection. Want this month's offer?" + STOPLINE, ar: null } },
  { key: 'features', name: 'lost_lead_alternative_v1', category: 'MARKETING', body: { en: "Hi {name}, thanks for considering the {model}. If it wasn't quite right, the YK family has other models that may fit better. Shall I share a short list?" + STOPLINE, ar: null } },
  { key: 'family', name: 'lost_lead_family_v1', category: 'MARKETING', body: { en: 'Hi {name}, choosing a car is a family decision. Bring the family for a relaxed weekend test drive of the {model} at {brand}. Shall I book a slot?' + STOPLINE, ar: null } },
  { key: 'ask', name: 'lost_lead_ask_reason_v1', category: 'MARKETING', body: { en: ASK, ar: null } },
  { key: 'permission', name: 'lost_lead_permission_v1', category: 'MARKETING', body: { en: 'Hi {name}, this is {brand}. You asked about the {model} a while ago. Would you like occasional updates on new arrivals and offers? Reply YES to subscribe. If not, just ignore this message.', ar: null } },
  { key: 'nudge', name: 'lost_lead_nudge_v1', category: 'MARKETING', draft: true, body: { en: 'Hi {name}, just checking you saw my message about the {model}. Happy to help whenever it suits you.' + STOPLINE, ar: null } },
  { key: 'voucher', name: 'lost_lead_voucher_v1', category: 'MARKETING', draft: true, body: { en: 'Hi {name}, a thank-you from {brand}: a voucher is waiting for you when you test drive the {model} this month. Shall I reserve one?' + STOPLINE, ar: null } },
  { key: 'monthly', name: 'lost_lead_monthly_v1', category: 'MARKETING', draft: true, body: { en: 'Hi {name}, this month at {brand}: new arrivals and offers around the {model}. Shall I send the details?' + STOPLINE, ar: null } }
];
/* engine bucket -> template key (noresp and noreason both ask the reason) */
const BUCKET_KEY = { price: 'price', stock: 'stock', thinking: 'thinking', competitor: 'competitor', features: 'features', family: 'family', noresp: 'ask', noreason: 'ask' };

const TITLES = /^(mr|mrs|ms|miss|dr|sayed|syed|sh|shaikh|sheikh|eng|haji)\.?$/i;
function firstName(n) {
  const parts = String(n || '').trim().split(/\s+/).filter(w => w && !TITLES.test(w));
  const p = parts[0];
  if (!p || /\d/.test(p)) return 'there';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}
/* the one place a {placeholder} turns into a value */
const VAR_VALUE = {
  name: r => firstName(r.name),
  brand: r => cleanText(r.brand) || 'Y.K. Almoayyed',
  model: r => cleanText(r.model) || 'car you asked about'
};
function fill(t, r) { return String(t).replace(/\{(\w+)\}/g, (m, k) => VAR_VALUE[k] ? VAR_VALUE[k](r) : m); }
/* placeholders in order of first appearance: {{1}}, {{2}}, {{3}} */
function tplVars(t) {
  const seen = [];
  (String(t).match(/\{(\w+)\}/g) || []).forEach(m => { const k = m.slice(1, -1); if (VAR_VALUE[k] && !seen.includes(k)) seen.push(k); });
  return seen;
}
const varValues = (t, r) => tplVars(t).map(k => VAR_VALUE[k](r));
/* the body as Meta wants it for approval, with numbered variables */
function tplBody(t) { const v = tplVars(t); return String(t).replace(/\{(\w+)\}/g, (m, k) => { const i = v.indexOf(k); return i < 0 ? m : `{{${i + 1}}}`; }); }

/** Template for a sequence key or an engine bucket id. */
function templateForKey(key) { const k = BUCKET_KEY[key] || key; return CATALOGUE.find(t => t.key === k) || null; }
const templateByName = name => CATALOGUE.find(t => t.name === name) || null;

module.exports = { CATALOGUE, BUCKET_KEY, STOPLINE, firstName, VAR_VALUE, fill, tplVars, varValues, tplBody, templateForKey, templateByName };
