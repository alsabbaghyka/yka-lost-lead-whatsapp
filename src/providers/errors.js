'use strict';
// Meta Cloud API error codes -> what this system does. Source: the error-codes
// page (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes),
// read 23 Nov 2026. kind:
//   retry     - transient; back off and try again, dead-letter after max attempts
//   permanent - this message will never go; record the outcome, do not retry
//   account   - credentials / account / billing problem; stop the whole queue and alert an admin
// Flags: undeliverable (stop the customer's sequence), optout (treat as an opt-out),
// window (needs a template instead of free text), templateProblem (fix the template in Meta).

const T = (kind, label, extra) => ({ kind, label, ...(extra || {}) });
const CODES = {
  0: T('account', 'Meta could not authenticate the app: the access token expired or was invalidated'),
  1: T('retry', 'Invalid request or a possible Meta server error'),
  2: T('retry', 'Meta service temporarily unavailable'),
  3: T('account', 'The app lacks a capability or permission'),
  4: T('retry', 'App API call rate limit reached'),
  10: T('account', 'Permission not granted or removed'),
  33: T('account', 'The business phone number has been deleted'),
  100: T('permanent', 'Unsupported or misspelled parameter'),
  190: T('account', 'Access token expired: generate a new system-user token'),
  200: T('account', 'Permission not granted or removed'),
  368: T('account', 'WhatsApp Business account restricted for a policy violation'),
  80007: T('retry', 'WhatsApp Business account rate limit reached'),
  130403: T('permanent', 'We have blocked this customer in WhatsApp'),
  130429: T('retry', 'Sending speed limit reached (throughput)'),
  130472: T('permanent', "Not sent: part of Meta's experiment group"),
  130497: T('permanent', 'Account restricted from messaging this country'),
  131000: T('retry', 'Unknown Meta error'),
  131005: T('account', 'Permission not granted or removed'),
  131008: T('permanent', 'Required parameter missing'),
  131009: T('permanent', 'Parameter value not valid'),
  131016: T('retry', 'Meta service temporarily unavailable'),
  131021: T('permanent', 'Sender and recipient are the same number'),
  131026: T('permanent', 'Not delivered: number not on WhatsApp, or the customer has not accepted the terms / has an old app', { undeliverable: true }),
  131031: T('account', 'Business account locked or verification failed'),
  131037: T('account', 'Phone number has no approved display name'),
  131042: T('account', 'Payment method problem on the WhatsApp account'),
  131045: T('account', 'Phone number registration problem'),
  131047: T('permanent', 'Outside the 24-hour customer service window: more than 24 hours since the customer last wrote, so only an approved template can be sent', { window: true }),
  131048: T('permanent', 'Spam rate limit: this number is restricted after customers blocked or reported messages'),
  131049: T('permanent', 'Meta held this marketing message back to protect engagement (marketing limit) — not retried automatically'),
  131050: T('permanent', 'The customer has turned off marketing messages from businesses in WhatsApp', { optout: true }),
  131051: T('permanent', 'Unsupported message type'),
  131052: T('permanent', 'Could not download media sent by the customer'),
  131053: T('permanent', 'Could not upload media'),
  131056: T('retry', 'Too many messages to this customer in a short time'),
  131057: T('account', 'WhatsApp Business account in maintenance mode'),
  131063: T('account', 'Marketing templates are disabled on the Cloud API for this account'),
  131064: T('account', 'Messaging limited because of template classification violations'),
  132000: T('permanent', 'Variable count does not match the approved template', { templateProblem: true }),
  132001: T('permanent', 'Template does not exist in this language or is not approved', { templateProblem: true }),
  132005: T('permanent', 'Translated text too long', { templateProblem: true }),
  132007: T('permanent', 'Template content violates WhatsApp policy', { templateProblem: true }),
  132012: T('permanent', 'Variable values are formatted wrongly', { templateProblem: true }),
  132015: T('permanent', 'Template paused by Meta for low quality', { templateProblem: true }),
  132016: T('permanent', 'Template permanently disabled by Meta', { templateProblem: true }),
  133004: T('retry', 'Meta server temporarily unavailable'),
  133010: T('account', 'Phone number not registered on the Cloud API'),
  135000: T('permanent', 'Unknown error with the request parameters'),
  2494100: T('retry', 'Account in maintenance mode: retry in a few minutes')
};

function classifyError({ code, http, network, title, details } = {}) {
  let base;
  if (code != null && CODES[code]) base = CODES[code];
  else if (code != null && code >= 200 && code <= 299) base = CODES[200];
  else if (network) base = T('retry', 'Network error reaching Meta');
  else if (http && (http >= 500 || http === 429)) base = T('retry', `Meta returned HTTP ${http}`);
  else if (http === 401 || http === 403) base = T('account', `Meta refused the credentials (HTTP ${http})`);
  else base = T('permanent', title || details || (code != null ? `Meta error ${code}` : `HTTP ${http || '?'}`));
  return { code: code == null ? null : Number(code), http: http || null, network: !!network, title: title || null, details: details || null,
    kind: base.kind, label: base.label, outcome: base.label,
    undeliverable: !!base.undeliverable, optout: !!base.optout, window: !!base.window, templateProblem: !!base.templateProblem };
}

module.exports = { classifyError, CODES };
