'use strict';

const { appendEntry } = require('../../lib/factory/ledger-store');

const [, , root, id] = process.argv;
if (!root || !id) process.exit(2);

try {
  const entry = appendEntry(root, { type: 'concurrent-test', status: 'PASS', id });
  process.stdout.write(`${entry.sequence}:${entry.hash}\n`);
} catch (error) {
  process.stderr.write(`${error.code || 'ERROR'}:${error.message}\n`);
  process.exit(1);
}
