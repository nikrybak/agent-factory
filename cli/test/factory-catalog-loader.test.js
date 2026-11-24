'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCatalog, loadCatalogRecord } = require('../lib/factory/catalog-loader');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-catalog-loader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('catalog document and record use the exact opened JSON bytes and raw digest', t => {
  const root = fixture(t);
  const firstBytes = Buffer.from('{\n  "items": [1, 2], "enabled": true\n}\n');
  const secondBytes = Buffer.from('{"items":[1,2],"enabled":true}');
  fs.writeFileSync(path.join(root, 'first.json'), firstBytes);
  fs.writeFileSync(path.join(root, 'second.json'), secondBytes);
  const expected = { items: [1, 2], enabled: true };
  const record = loadCatalogRecord(root, 'first.json');
  assert.deepEqual(record, {
    document: expected,
    contentDigest: crypto.createHash('sha256').update(firstBytes).digest('hex'),
  });
  assert.deepEqual(loadCatalog(root, 'first.json'), expected);
  const second = loadCatalogRecord(root, 'second.json');
  assert.deepEqual(second.document, expected);
  assert.notEqual(second.contentDigest, record.contentDigest);
});

test('catalog loader forwards bounds and exposes only fixed invalid-JSON errors', t => {
  const root = fixture(t);
  const secret = 'catalog-secret-canary';
  fs.writeFileSync(path.join(root, 'invalid.json'), `{${secret}`);
  assert.throws(() => loadCatalog(root, 'invalid.json'), error => {
    assert.equal(error.code, 'FACTORY_CATALOG_JSON_INVALID');
    assert.equal(error.message, 'governed catalog JSON is invalid');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  fs.writeFileSync(path.join(root, 'bounded.json'), '{"large":true}');
  assert.throws(
    () => loadCatalogRecord(root, 'bounded.json', { maxBytes: 4 }),
    error => error.code === 'FACTORY_FILESYSTEM_PATH_UNSAFE',
  );
  fs.writeFileSync(path.join(root, 'primitive.json'), 'null');
  assert.equal(loadCatalog(root, 'primitive.json'), null);
});

test('authoritative catalog consumers do not bypass the governed loader', () => {
  const repository = path.resolve(__dirname, '../..');
  const consumers = [
    'cli/bin/infra.js',
    'cli/lib/factory/city.js',
    'cli/lib/factory/detect.js',
    'cli/lib/factory/engine.js',
    'cli/lib/factory/evidence-providers.js',
    'cli/lib/factory/policy.js',
    'cli/lib/factory/stage-providers.js',
  ];
  for (const relative of consumers) {
    const source = fs.readFileSync(path.join(repository, relative), 'utf8');
    const bypass = source.split(/\r?\n/).filter(line => line.includes('readFileSync') && line.includes('factory/catalog'));
    assert.deepEqual(bypass, [], `${relative} bypasses catalog-loader`);
  }
});
