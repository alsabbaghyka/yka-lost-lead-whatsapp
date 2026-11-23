'use strict';
// Meta WhatsApp Cloud API (Graph API). Request and response shapes follow
// docs/META-API-NOTES.md. Methods never throw for API errors: they return
// {ok:false, error} with the error classified (src/providers/errors.js).
const { classifyError } = require('./errors');

const TIMEOUT_MS = 15000;

class CloudProvider {
  constructor(cfg, deps = {}) {
    this.name = 'cloud';
    this.cfg = cfg;
    this.fetch = deps.fetch || globalThis.fetch;
  }
  url(path) { return `${this.cfg.graphBase}/${this.cfg.graphVersion}/${path}`; }
  headers() { return { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' }; }

  async call(url, init) {
    let res;
    try { res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch (e) { return { ok: false, error: classifyError({ network: true, details: String(e && e.message || e) }) }; }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (res.ok && !(json && json.error)) return { ok: true, json };
    const e = (json && json.error) || {};
    return { ok: false, error: classifyError({ code: e.code, http: res.status, title: e.message, details: e.error_data && e.error_data.details }) };
  }

  async send(body) {
    const r = await this.call(this.url(`${this.cfg.phoneNumberId}/messages`), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!r.ok) return r;
    const m = (r.json.messages || [])[0] || {};
    const c = (r.json.contacts || [])[0] || {};
    if (!m.id) return { ok: false, error: classifyError({ code: 131000, details: 'Response had no message id' }) };
    return { ok: true, wamid: m.id, waId: c.wa_id || null, pacing: m.message_status || null };
  }

  sendTemplate({ to, name, language, params }) {
    const template = { name, language: { code: language } };
    if (params && params.length) template.components = [{ type: 'body', parameters: params.map(text => ({ type: 'text', text: String(text) })) }];
    return this.send({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template });
  }
  sendText({ to, body }) {
    return this.send({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } });
  }

  async listTemplates() {
    const out = [];
    let url = this.url(`${this.cfg.wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100`);
    for (let page = 0; url && page < 50; page++) {
      const r = await this.call(url, { method: 'GET', headers: this.headers() });
      if (!r.ok) { const err = new Error(r.error.label + (r.error.title ? ': ' + r.error.title : '')); err.meta = r.error; throw err; }
      for (const t of r.json.data || []) {
        const body = (t.components || []).find(c => String(c.type).toUpperCase() === 'BODY');
        out.push({ id: t.id, name: t.name, language: t.language, status: t.status, category: t.category, body: body ? body.text : '', reason: t.rejected_reason || null });
      }
      url = r.json.paging && r.json.paging.next ? r.json.paging.next : null;
    }
    return out;
  }

  async testConnection() {
    const r = await this.call(this.url(`${this.cfg.wabaId}/message_templates?fields=name,status&limit=1`), { method: 'GET', headers: this.headers() });
    if (!r.ok) return { ok: false, detail: `${r.error.label}${r.error.title ? ' — ' + r.error.title : ''}`, error: r.error };
    return { ok: true, detail: `Reached WhatsApp Business account ${this.cfg.wabaId} with Graph API ${this.cfg.graphVersion}; templates readable.` };
  }
}

module.exports = { CloudProvider };
