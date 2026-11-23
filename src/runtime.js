'use strict';
// Builds the running system: config -> database -> context, then either
//   start(): a plain HTTP server with background workers (Windows service, Docker), or
//   api/index.js: a Vercel function, where due work runs after requests (runDue).
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
const Auth = require('./auth');
const { audit } = require('./audit');
const { log } = require('./mask');

const XLSX_SHA256 = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';
function checkVendor() {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'xlsx.js'))).digest('hex');
  if (h !== XLSX_SHA256) throw new Error('vendor/xlsx.js does not match the pinned SheetJS 0.20.3 hash; refusing to start');
}

function env() { return { ...readDotEnv(path.join(process.cwd(), '.env')), ...process.env }; }

/** One round of due work, within a time budget. The scheduler runs at most once a minute
    (remembered in the database, so many instances do not all run it) unless forced. */
async function runDue(ctx, { budgetMs = 8000, force = false } = {}) {
  const deadline = Date.now() + budgetMs;
  const out = { webhooks: 0, scheduler: null, outbox: null };
  if (ctx.provider.flush) await ctx.provider.flush();
  out.webhooks += await ctx.processWebhooks();
  const now = ctx.clock.now();
  const last = await ctx.db.prepare("SELECT value FROM system_state WHERE key = 'last_tick'").get();
  if (force || !last || now - Number(last.value) >= 60e3) {
    // claim this minute's tick: only the process whose UPDATE/INSERT changes the row runs it
    const claimed = last
      ? (await ctx.db.prepare("UPDATE system_state SET value = ?, updated_at = ? WHERE key = 'last_tick' AND value = ?").run(String(now), ctx.nowIso(), last.value)).changes
      : (await ctx.db.prepare("INSERT OR IGNORE INTO system_state(key, value, updated_at) VALUES ('last_tick', ?, ?)").run(String(now), ctx.nowIso())).changes;
    if (claimed || force) out.scheduler = await Scheduler.tick(ctx, { deadline });
  }
  if (Date.now() < deadline) out.outbox = await Sender.processOutbox(ctx, { deadline });
  if (ctx.provider.flush) await ctx.provider.flush();
  if (Date.now() < deadline) out.webhooks += await ctx.processWebhooks();
  return out;
}

/** Config, database, context; first admin from the environment when there are no users. */
async function boot({ env: e = env(), clock } = {}) {
  checkVendor();
  const cfg = loadConfig(e);
  const db = await openDb(cfg.dbPath, { tursoUrl: cfg.tursoUrl, tursoToken: cfg.tursoToken });
  const ctx = createContext({ cfg, db, clock });
  ctx.runDue = opts => runDue(ctx, opts);
  const interrupted = await Sender.recoverInFlight(ctx);
  if (interrupted) log(`${interrupted} message(s) were left mid-send and went to dead letters for a person to check`);
  // the mock and dry-run providers approve the catalogue locally; the cloud provider is synced from the Templates screen
  if (cfg.provider !== 'cloud' && !(await db.prepare('SELECT 1 FROM templates LIMIT 1').get())) await Templates.sync(ctx, null);
  if (cfg.bootstrapAdmin && cfg.bootstrapAdmin.reset) {
    // one-time repair where there is no command line: make this email an active admin with this
    // password. Turn BOOTSTRAP_ADMIN_RESET off afterwards, or it re-applies on every cold start.
    const b = cfg.bootstrapAdmin, now = new Date().toISOString();
    const hash = Auth.hashPassword(b.password);
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(b.email);
    if (existing) await db.prepare("UPDATE users SET pw_hash = ?, role = 'admin', active = 1, name = ? WHERE id = ?").run(hash, b.name, existing.id);
    else await db.prepare("INSERT INTO users(email, name, role, pw_hash, created_at) VALUES (?,?,'admin',?,?)").run(b.email, b.name, hash, now);
    await audit(db, null, 'user.reset_by_environment', b.email, { created: !existing });
    log('BOOTSTRAP_ADMIN_RESET applied for the admin in BOOTSTRAP_ADMIN_EMAIL; turn it off now');
  } else if (cfg.bootstrapAdmin && !(await db.prepare('SELECT 1 FROM users LIMIT 1').get())) {
    try {
      const u = await Auth.createUser(db, { ...cfg.bootstrapAdmin, role: 'admin' });
      await audit(db, null, 'user.create', u.email, { role: 'admin', via: 'BOOTSTRAP_ADMIN_* environment' });
      log('Created the first admin from BOOTSTRAP_ADMIN_EMAIL');
    } catch (err) { if (!/UNIQUE/i.test(String(err.message))) throw err; }   // another instance created it first
  }
  return ctx;
}

function startWorkers(ctx) {
  let busy = false;
  const work = async () => {
    if (busy) return; busy = true;
    try { await runDue(ctx, { budgetMs: 30000 }); }
    catch (e) { log('worker error', String(e && e.stack || e)); }
    finally { busy = false; }
  };
  const t1 = setInterval(work, ctx.cfg.workerIntervalMs);
  const t2 = setTimeout(work, 1000);
  return () => { clearInterval(t1); clearTimeout(t2); };
}

async function start({ env: e = env(), listen = true, clock, workers = true } = {}) {
  const ctx = await boot({ env: e, clock });
  ctx.background = fn => setImmediate(() => Promise.resolve().then(fn).catch(err => log('background work', String(err && err.stack || err))));
  const server = http.createServer(createApp(ctx));
  server.requestTimeout = 60e3; server.headersTimeout = 20e3;
  const stopWorkers = workers ? startWorkers(ctx) : () => {};
  if (listen) await new Promise(res => server.listen(ctx.cfg.port, ctx.cfg.host, res));
  const users = (await ctx.db.prepare('SELECT COUNT(*) n FROM users').get()).n;
  log(`Lost Lead WhatsApp listening on http://${ctx.cfg.host}:${ctx.cfg.port} — provider ${ctx.cfg.provider}, Graph ${ctx.cfg.graphVersion}, database ${ctx.db.kind === 'libsql' ? 'Turso' : ctx.cfg.dbPath}`);
  if (!users) log('No users yet. Create the first admin:  node cli.js create-admin --email you@example.com --name "Your Name"');
  const stop = () => new Promise(res => { stopWorkers(); server.close(async () => { await ctx.db.close(); res(); }); });
  return { ctx, server, stop };
}

module.exports = { boot, start, runDue, startWorkers, checkVendor, env };
