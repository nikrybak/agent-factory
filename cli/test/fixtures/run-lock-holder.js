'use strict';

const { FactoryStore } = require('../../lib/factory/store');

const [root, runId = 'run-1'] = process.argv.slice(2);
const store = new FactoryStore(root);
const lock = store.acquireRunLock(runId, 'tests', { ttlMs: 25 });
if (process.send) process.send({ type: 'ready', token: lock.token });

process.on('message', message => {
  if (message?.type !== 'release') return;
  try {
    store.releaseRunLock(runId, lock.token);
    if (process.send) process.send({ type: 'released' });
    process.exit(0);
  } catch (error) {
    if (process.send) process.send({ type: 'error', code: error.code });
    process.exit(1);
  }
});
