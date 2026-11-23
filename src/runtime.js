'use strict';
// Builds the running system: config -> database -> context -> HTTP server -> workers.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, readDotEnv } = require('./config');
const { openDb } = require('./db');
const { createContext } = require('./context');
const { createApp } = require('./http/app');
const Scheduler = require('./services/scheduler');
const Sender = require('./services/sender');
const Templates = require('./services/templates');
const { log } = require('./mask');

const XLSX_SHA256 = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';
function checkVendor() {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'xlsx.js'))).digest('hex');
  if (h !== XLSX_SHA256) throw new Error('vendor/xlsx.js does not match the pinned SheetJS 0.20.3 hash; refusing to start');
}

function env() { return { ...readDotEnv(path.join(process.cwd(), '.env')), ...process.env }; }

function startWorkers(ctx) {
  let busy = false;
  const work = async () => {
    if (busy) return; busy = true;
    try {
      if (ctx.provider.flush) await ctx.provider.flush();
      await ctx.processWebhooks();
      await Sender.processOutbox(ctx);
    } catch (e) { log('worker error', String(e && e.stack || e)); }
    finally { busy = false; }
  };
  const tick = () => { try { const r = Scheduler.tick(ctx); if (r.enqueued) log('scheduler queued', r.enqueued); } catch (e) { log('scheduler error', String(e && e.stack || e)); } };
  const t1 = setInterval(work, ctx.cfg.workerIntervalMs);
  const t2 = setInterval(tick, ctx.cfg.schedulerIntervalMs);
  const t3 = setTimeout(tick, 1000);
  return () => { clearInterval(t1); clearInterval(t2); clearTimeout(t3); };
}

async function start({ env: e = env(), listen = true, clock, workers = true } = {}) {
  checkVendor();
  const cfg = loadConfig(e);
  const db = openDb(cfg.dbPath);
  const ctx = createContext({ cfg, db, clock });
  const interrupted = Sender.recoverInFlight(ctx);
  if (interrupted) log(`${interrupted} message(s) were mid-send at the last shutdown and went to dead letters for a person to check`);
  if (cfg.provider !== 'cloud') {
    // the mock and dry-run providers approve the catalogue locally; the cloud provider is synced from the Templates screen
    if (!db.prepare('SELECT 1 FROM templates LIMIT 1').get()) await Templates.sync(ctx, null);
  }
  const server = http.createServer(createApp(ctx));
  server.requestTimeout = 60e3; server.headersTimeout = 20e3;
  const stopWorkers = workers ? startWorkers(ctx) : () => {};
  if (listen) await new Promise(res => server.listen(cfg.port, cfg.host, res));
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  log(`Lost Lead WhatsApp listening on http://${cfg.host}:${cfg.port} — provider ${cfg.provider}, Graph ${cfg.graphVersion}, database ${cfg.dbPath}`);
  if (!users) log('No users yet. Create the first admin:  node cli.js create-admin --email you@example.com --name "Your Name"');
  const stop = () => new Promise(res => { stopWorkers(); server.close(() => { db.close(); res(); }); });
  return { ctx, server, stop };
}

module.exports = { start, startWorkers, checkVendor, env };
