'use strict';
// An in-process stand-in for Meta. Sends succeed with realistic ids, and the
// matching sent / delivered / read (or failed 131026) webhooks are produced in
// Meta's documented shape, signed with the app secret, and handed to the same
// webhook entry point the real ones use. Nothing leaves the process.
const crypto = require('node:crypto');
const P = require('./payloads');
const { classifyError } = require('./errors');
const { CATALOGUE } = require('../rules/templates');

class MockProvider {
  /** deps.deliver(rawBody, headers) -> Promise: where webhooks go (the app's webhook handler). */
  constructor(cfg, deps = {}) {
    this.name = 'mock';
    this.cfg = cfg;
    this.deliver = deps.deliver || (async () => {});
    this.now = deps.now || (() => Date.now());
    this.queue = [];
    this.unreachable = new Set();       // mobiles that are "not on WhatsApp"
    this.failEvery = Number(cfg.mockFailEvery || 0);
    this.pendingErrors = [];
    this.sent = [];
  }
  wamid() { return 'wamid.MOCK' + crypto.randomBytes(12).toString('base64url'); }
  ts() { return Math.floor(this.now() / 1000); }
  enqueue(payload) {
    const raw = JSON.stringify(payload);
    this.queue.push({ raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': P.sign(raw, this.cfg.appSecret) } });
  }
  /** Inject an API error for the next send, e.g. {code:130429}. */
  failNext(err) { this.pendingErrors.push(err); }
  isUnreachable(to) {
    if (this.unreachable.has(to)) return true;
    return this.failEvery > 0 && parseInt(String(to).slice(-2), 10) % this.failEvery === 0;
  }
  async sendOne(to, record) {
    if (this.pendingErrors.length) return { ok: false, error: classifyError(this.pendingErrors.shift()) };
    const wamid = this.wamid();
    this.sent.push({ ...record, to, wamid });
    const base = { wabaId: this.cfg.wabaId, phoneNumberId: this.cfg.phoneNumberId, wamid, to, timestamp: this.ts() };
    if (this.isUnreachable(to)) {
      this.enqueue(P.statusPayload({ ...base, status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable', error_data: { details: 'Message Undeliverable.' } }] }));
    } else {
      ['sent', 'delivered', 'read'].forEach(status => this.enqueue(P.statusPayload({ ...base, status })));
    }
    return { ok: true, wamid, waId: P.waId(to), pacing: null };
  }
  sendTemplate({ to, name, language, params }) { return this.sendOne(to, { kind: 'template', name, language, params }); }
  sendText({ to, body }) { return this.sendOne(to, { kind: 'text', body }); }

  /** Pretend the customer wrote back. kind: text | button | button_reply | list_reply */
  simulateInbound({ from, text, kind = 'text', contextId, name, userId }) {
    const id = this.wamid();
    this.enqueue(P.inboundPayload({ wabaId: this.cfg.wabaId, phoneNumberId: this.cfg.phoneNumberId, from, name, id, timestamp: this.ts(), kind, text, contextId, userId }));
    return id;
  }
  /** Deliver every queued webhook, in order. Safe to call repeatedly. */
  async flush() {
    while (this.queue.length) { const w = this.queue.shift(); await this.deliver(w.raw, w.headers); }
  }
  async listTemplates() {
    return CATALOGUE.map((t, i) => ({ id: String(9000 + i), name: t.name, language: 'en', category: t.category,
      status: t.draft && this.cfg.mockApproveDrafts === false ? 'PENDING' : 'APPROVED', body: t.body.en, reason: null }));
  }
  async testConnection() { return { ok: true, detail: 'Mock provider: nothing is sent to Meta. Webhooks are simulated and signed locally.' }; }
}

module.exports = { MockProvider };
