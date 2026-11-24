'use strict';
const crypto = require('node:crypto');

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new TypeError('value is not JSON-compatible');
  if (seen.has(value)) throw new TypeError('cyclic value is not JSON-compatible');
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => canonicalize(item, seen));
  else {
    result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function stableStringify(value, space = 0) { return JSON.stringify(canonicalize(value), null, space); }
function stableDigest(value) { return crypto.createHash('sha256').update(stableStringify(value)).digest('hex'); }

module.exports = { canonicalize, stableStringify, stableDigest };
