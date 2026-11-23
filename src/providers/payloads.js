'use strict';
// Webhook payloads in the shape Meta documents (docs/META-API-NOTES.md), used by
// the mock provider and by tests. One notification per item, as Meta sends them.
const crypto = require('node:crypto');

const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const waId = mobile => String(mobile).replace(/^\+/, '');
const envelope = (wabaId, value, field = 'messages') => ({ object: 'whatsapp_business_account', entry: [{ id: String(wabaId || '0'), changes: [{ field, value }] }] });
const meta = (phoneNumberId, display = '97317000000') => ({ display_phone_number: display, phone_number_id: String(phoneNumberId || '0') });

function statusPayload({ wabaId, phoneNumberId, wamid, status, to, timestamp, errors }) {
  const st = { id: wamid, status, timestamp: String(timestamp), recipient_id: waId(to) };
  if (errors) st.errors = errors;
  return envelope(wabaId, { messaging_product: 'whatsapp', metadata: meta(phoneNumberId), statuses: [st] });
}
/** kind: text | button | button_reply | list_reply */
function inboundPayload({ wabaId, phoneNumberId, from, name = 'Customer', id, timestamp, kind = 'text', text, replyId, contextId, userId }) {
  const m = { from: waId(from), id, timestamp: String(timestamp), type: 'text' };
  if (userId) m.from_user_id = userId;
  if (kind === 'text') m.text = { body: text };
  else if (kind === 'button') { m.type = 'button'; m.button = { payload: text, text }; }
  else if (kind === 'button_reply') { m.type = 'interactive'; m.interactive = { type: 'button_reply', button_reply: { id: replyId || text, title: text } }; }
  else if (kind === 'list_reply') { m.type = 'interactive'; m.interactive = { type: 'list_reply', list_reply: { id: replyId || text, title: text, description: '' } }; }
  if (contextId) m.context = { from: '97317000000', id: contextId };
  const contact = { profile: { name }, wa_id: waId(from) };
  if (userId) contact.user_id = userId;
  return envelope(wabaId, { messaging_product: 'whatsapp', metadata: meta(phoneNumberId), contacts: [contact], messages: [m] });
}
function templateStatusPayload({ wabaId, name, language = 'en', event, reason = 'NONE', id = 1 }) {
  return envelope(wabaId, { event, message_template_id: id, message_template_name: name, message_template_language: language, reason, message_template_category: 'MARKETING' }, 'message_template_status_update');
}

module.exports = { sign, waId, statusPayload, inboundPayload, templateStatusPayload };
