// Dependency-free structural checks. This is not a full OpenAPI validator.
const assert = require('node:assert/strict');
const spec = require('../docs/openapi.json');
assert.equal(spec.openapi, '3.0.3');
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    assert(value.$ref.startsWith('#/'));
    let target = spec;
    for (const piece of value.$ref.slice(2).split('/')) target = target[piece.replaceAll('~1', '/').replaceAll('~0', '~')];
    assert(target, `Unresolved reference ${value.$ref}`);
  }
  if (value.properties) for (const key of value.required || []) assert(key in value.properties);
  for (const child of Object.values(value)) walk(child);
}
walk(spec);
const operations = new Set();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const operation of Object.values(methods)) {
    assert(!operations.has(operation.operationId)); operations.add(operation.operationId);
    assert(operation.responses['401'] && operation.responses['500']);
    assert(Object.keys(operation.responses).some(status => status.startsWith('2')));
    const parameters = (operation.parameters || []).map(p => spec.components.parameters[p.$ref.split('/').at(-1)]);
    assert.deepEqual([...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort(),
      parameters.filter(p => p.in === 'path').map(p => p.name).sort());
  }
}
assert.equal(operations.size, 9);
console.log('OpenAPI structure, references and nine operations checked.');
