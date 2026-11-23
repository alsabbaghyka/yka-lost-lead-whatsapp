'use strict';
// The bundle every service receives: database, config, clock and provider.
const { makeProvider } = require('./providers');
const { systemClock } = require('./clock');

function createContext({ cfg, db, clock, provider }) {
  clock = clock || systemClock;
  const ctx = { cfg, db, clock, nowIso: () => new Date(clock.now()).toISOString() };
  const webhook = require('./webhook');
  // the mock provider hands its signed webhooks to the same entry point Meta's use
  ctx.provider = provider || makeProvider(cfg, { deliver: (raw, headers) => webhook.receive(ctx, raw, headers), now: () => clock.now() });
  ctx.processWebhooks = () => webhook.processPending(ctx);
  return ctx;
}
module.exports = { createContext };
