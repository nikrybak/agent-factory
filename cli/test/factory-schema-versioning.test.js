'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const schema = name => JSON.parse(fs.readFileSync(path.join(root, 'factory', 'schema', name), 'utf8'));

function acceptsObject(definition, value) {
  const keys = new Set(Object.keys(definition.properties || {}));
  return (definition.required || []).every(key => Object.hasOwn(value, key))
    && (definition.additionalProperties !== false || Object.keys(value).every(key => keys.has(key)));
}

test('versioned schemas encode negative 1.0/1.1 migration fixtures', () => {
  const project = schema('project.schema.json');
  const legacyDeclaration = { family: 'node', root: '.' };
  const currentDeclaration = { id: 'web', family: 'node', adapterId: 'node-npm', root: '.' };
  assert.equal(acceptsObject(project.$defs.stackDeclarationV10, legacyDeclaration), true);
  assert.equal(acceptsObject(project.$defs.stackDeclarationV10, currentDeclaration), false);
  assert.equal(acceptsObject(project.$defs.stackDeclarationV11, legacyDeclaration), false);
  assert.equal(acceptsObject(project.$defs.stackDeclarationV11, currentDeclaration), true);

  const signals = schema('stack-signal.schema.json');
  assert.equal(Object.hasOwn(signals.$defs.signalV10.properties, 'markerRole'), false);
  assert.equal(Object.hasOwn(signals.$defs.signalV11.properties, 'markerRole'), true);

  const adapters = schema('adapter.schema.json');
  assert.equal(Object.hasOwn(adapters.$defs.operationV10.properties, 'commands'), false);
  assert.equal(Object.hasOwn(adapters.$defs.operationV10.properties, 'timeoutMs'), false);
  assert.equal(Object.hasOwn(adapters.$defs.operationV11.properties, 'commands'), true);
  assert.equal(adapters.$defs.operationV11.properties.timeoutMs.$ref, '#/$defs/commandTimeoutMs');
  assert.deepEqual(adapters.$defs.commandTimeoutMs, { type: 'integer', minimum: 1000, maximum: 21600000 });
  assert.equal(adapters.allOf[0].then.properties.adapters.items.$ref, '#/$defs/adapterV10');
  assert.equal(adapters.allOf[1].then.properties.adapters.items.$ref, '#/$defs/adapterV11');

  const providers = schema('evidence-provider.schema.json');
  assert.equal(providers.$defs.providerV10.properties.operations.items.$ref, '#/$defs/operationName');
  assert.equal(providers.$defs.providerV11.properties.operations.items.$ref, '#/$defs/operationTarget');
  assert.equal(providers.$defs.operationTarget.properties.notApplicable.items.properties.reason.maxLength, 500);
});
