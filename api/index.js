'use strict';
// Vercel entry. Every path is rewritten here (vercel.json) as /api/index?__p=<original path>.
// There are no background workers on Vercel, so due work (webhook queue, scheduler, outbox)
// runs after responses via waitUntil, at most every 15 seconds per instance, plus a daily cron.
// Data lives in Turso (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN), never on the instance's disk.
const { boot } = require('../src/runtime');
const { createApp } = require('../src/http/app');
const { log } = require('../src/mask');

let waitUntil = null;
try { ({ waitUntil } = require('@vercel/functions')); } catch { /* local run */ }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      // on Vercel the disk does not last: refuse to run on a local file there
      if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is not set: connect a Turso database to this Vercel project (Storage).');
      const ctx = await boot({ env: process.env });
      ctx.background = fn => { const p = Promise.resolve().then(fn).catch(e => log('background work', String(e && e.stack || e))); if (waitUntil) waitUntil(p); return p; };
      return { ctx, app: createApp(ctx) };
    })();
    ready.catch(() => { ready = null; });   // retry the boot on the next request
  }
  return ready;
}

let lastWork = 0;
module.exports = async function handler(req, res) {
  // restore the original path the visitor asked for
  const u = new URL(req.url, 'http://local');
  const orig = u.searchParams.get('__p');
  if (orig != null) { u.searchParams.delete('__p'); req.url = (orig.startsWith('/') ? orig : '/' + orig) + (u.search || ''); }

  let sys;
  try { sys = await init(); }
  catch (e) {
    log('boot failed', String(e && e.stack || e));
    res.statusCode = 503; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Lost Lead WhatsApp is not ready: ' + (e && e.message || e));
  }
  const { ctx, app } = sys;

  // Vercel Cron (vercel.json) — authorised with CRON_SECRET
  if (req.url.split('?')[0] === '/api/cron') {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) { res.statusCode = 401; return res.end('Unauthorized'); }
    const out = await ctx.runDue({ budgetMs: 50000, force: true });
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(out));
  }

  await app(req, res);

  if (Date.now() - lastWork > 15000) {
    lastWork = Date.now();
    ctx.background(() => ctx.runDue({ budgetMs: 20000 }));
  }
};
