'use strict';
// Configuration comes from the environment (and an optional .env file, read
// without any dependency). Secrets never have defaults.
const fs = require('node:fs');
const path = require('node:path');

function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function loadConfig(env = process.env) {
  const e = k => (env[k] == null ? '' : String(env[k]).trim());
  const provider = e('WA_PROVIDER') || 'mock';
  if (!['cloud', 'mock', 'dry-run'].includes(provider)) throw new Error('WA_PROVIDER must be cloud, mock or dry-run');
  const graphVersion = e('WA_GRAPH_VERSION') || 'v27.0';
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('WA_GRAPH_VERSION must look like v27.0');
  const c = {
    port: Number(e('PORT') || 8080),
    host: e('HOST') || '127.0.0.1',
    dbPath: e('DB_PATH') || path.join(process.cwd(), 'data', 'lost-lead.db'),
    backupDir: e('BACKUP_DIR') || path.join(process.cwd(), 'backups'),
    publicUrl: (e('PUBLIC_URL') || '').replace(/\/$/, ''),
    cookieSecure: e('COOKIE_SECURE') === '1' || e('COOKIE_SECURE') === 'true',
    sessionHours: Number(e('SESSION_HOURS') || 12),
    provider,
    graphVersion,
    graphBase: e('WA_GRAPH_BASE') || 'https://graph.facebook.com',
    accessToken: e('WA_ACCESS_TOKEN'),
    phoneNumberId: e('WA_PHONE_NUMBER_ID'),
    wabaId: e('WA_WABA_ID'),
    appSecret: e('WA_APP_SECRET'),
    verifyToken: e('WA_VERIFY_TOKEN'),
    workerIntervalMs: Number(e('WORKER_INTERVAL_MS') || 2000),
    schedulerIntervalMs: Number(e('SCHEDULER_INTERVAL_MS') || 60000),
    mockFailEvery: Number(e('MOCK_FAIL_EVERY') || 0),   // mock: every Nth number is "not on WhatsApp"
    mockApproveDrafts: e('MOCK_APPROVE_DRAFTS') !== '0'
  };
  if (provider === 'cloud') {
    const missing = ['WA_ACCESS_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_WABA_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN'].filter(k => !e(k));
    if (missing.length) throw new Error('WA_PROVIDER=cloud needs ' + missing.join(', '));
  }
  // mock and dry-run still verify webhook signatures: a random secret per start, never a known string
  if (!c.appSecret && provider !== 'cloud') c.appSecret = require('node:crypto').randomBytes(32).toString('hex');
  if (!c.verifyToken && provider !== 'cloud') c.verifyToken = require('node:crypto').randomBytes(16).toString('hex');
  return c;
}

module.exports = { loadConfig, readDotEnv };
