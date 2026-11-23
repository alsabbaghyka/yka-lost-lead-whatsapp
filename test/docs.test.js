'use strict';
// docs/openapi.yaml must list every route the server has.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every API route is in docs/openapi.yaml', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'http', 'app.js'), 'utf8');
  const yaml = fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8');
  const routes = [...src.matchAll(/r\('(GET|POST|PUT|PATCH|DELETE)', [`'](\/[^`']+)[`']/g)].map(m => m[2]);
  const actions = (src.match(/for \(const action of \[([^\]]+)\]/) || [])[1].match(/'(\w+)'/g).map(s => s.slice(1, -1));
  const all = routes.flatMap(r => r.includes('${action}') ? actions.map(a => r.replace('${action}', a)) : [r]);
  assert.ok(all.length > 40);
  const missing = all.map(r => r.replace(/:(\w+)/g, '{$1}')).filter(r => !yaml.includes(`  ${r}:`));
  assert.deepEqual(missing, []);
});
