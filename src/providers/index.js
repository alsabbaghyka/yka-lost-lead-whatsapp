'use strict';
const { CloudProvider } = require('./cloud');
const { MockProvider } = require('./mock');
const { DryRunProvider } = require('./dryrun');

function makeProvider(cfg, deps = {}) {
  if (cfg.provider === 'cloud') return new CloudProvider(cfg, deps);
  if (cfg.provider === 'dry-run') return new DryRunProvider(cfg, deps);
  return new MockProvider(cfg, deps);
}
module.exports = { makeProvider };
