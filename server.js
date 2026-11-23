'use strict';
// node server.js  — see README.md and docs/INTEGRATION.md
const { start } = require('./src/runtime');

start().then(({ stop }) => {
  const bye = sig => { console.log(`${sig}: stopping…`); stop().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
}).catch(e => { console.error(e.message || e); process.exit(1); });
