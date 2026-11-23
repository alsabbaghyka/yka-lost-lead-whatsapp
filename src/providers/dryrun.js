'use strict';
// Records what would be sent and returns a fake id. Never sends, never produces
// webhooks: messages stay at "sent" in the timeline. Templates are treated as
// approved so a full campaign can be rehearsed; the cloud provider never does that.
const { CATALOGUE } = require('../rules/templates');

class DryRunProvider {
  constructor(cfg = {}) { this.name = 'dry-run'; this.cfg = cfg; this.sent = []; this.n = 0; }
  async sendTemplate(m) { this.sent.push({ kind: 'template', ...m }); return { ok: true, wamid: 'dryrun.' + (++this.n) + '.' + Date.now(), waId: null, pacing: null }; }
  async sendText(m) { this.sent.push({ kind: 'text', ...m }); return { ok: true, wamid: 'dryrun.' + (++this.n) + '.' + Date.now(), waId: null, pacing: null }; }
  async listTemplates() { return CATALOGUE.map((t, i) => ({ id: 'dry' + i, name: t.name, language: 'en', category: t.category, status: 'APPROVED', body: t.body.en, reason: null })); }
  async testConnection() { return { ok: true, detail: 'Dry-run provider: messages are recorded, never sent.' }; }
}
module.exports = { DryRunProvider };
