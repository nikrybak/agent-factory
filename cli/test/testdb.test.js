'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FAST_FLAGS, LABEL, testdbMain, upArgs, waitReady } = require('../lib/testdb');

function fakeDocker(responses) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const response = responses.shift() ?? { status: 0, stdout: '', stderr: '' };
    return response;
  };
  return { calls, run };
}

function io(extra = {}) {
  const out = [];
  const err = [];
  return { out, err, options: { out: line => out.push(line), err: line => err.push(line), ...extra } };
}

test('up arguments bind loopback, use tmpfs, label the container and switch durability off', () => {
  const argv = upArgs({ name: 'pc-test-pg-x', port: '55490' });
  assert.deepEqual(argv.slice(0, 8), ['run', '-d', '--name', 'pc-test-pg-x', '--label', LABEL, '-p', '127.0.0.1:55490:5432']);
  assert.ok(argv.includes('/var/lib/postgresql/data:rw,size=2g'));
  assert.ok(argv.includes('postgres:17'));
  assert.deepEqual(argv.slice(-FAST_FLAGS.length), FAST_FLAGS);
  assert.ok(upArgs({ name: 'bc-db', port: 55491, image: 'postgres:16', user: 'billing', database: 'billing' }).includes('POSTGRES_DB=billing'));
  assert.throws(() => upArgs({ name: 'Bad Name', port: 55490 }), /invalid container name/);
  assert.throws(() => upArgs({ name: 'ok-name', port: 80 }), /invalid port/);
  assert.throws(() => upArgs({ name: 'ok-name', port: 'x' }), /invalid port/);
});

test('waitReady polls pg_isready until it succeeds or gives up', () => {
  const ready = fakeDocker([{ status: 2 }, { status: 0 }]);
  assert.equal(waitReady('db', { run: ready.run, sleep: () => {} }), true);
  assert.deepEqual(ready.calls[0], ['docker', 'exec', 'db', 'pg_isready', '-q']);
  const never = fakeDocker([{ status: 2 }, { status: 2 }]);
  assert.equal(waitReady('db', { run: never.run, attempts: 2, sleep: () => {} }), false);
  assert.equal(waitReady('db', { run: fakeDocker([{ status: 1 }]).run, attempts: 1 }), false);
});

test('up prints the connection URL, down removes with volumes, list filters by label', () => {
  const up = fakeDocker([{ status: 0, stdout: 'id' }]);
  const upIo = io({ run: up.run, wait: () => true });
  assert.equal(testdbMain(['up', '--name', 'pc-test-pg-x', '--port', '55490'], upIo.options), 0);
  assert.deepEqual(upIo.out, ['postgres://player:player@127.0.0.1:55490/player_schema']);
  const down = fakeDocker([{ status: 0 }]);
  const downIo = io({ run: down.run });
  assert.equal(testdbMain(['down', '--name', 'pc-test-pg-x'], downIo.options), 0);
  assert.deepEqual(down.calls[0], ['docker', 'rm', '-f', '-v', 'pc-test-pg-x']);
  const list = fakeDocker([{ status: 0, stdout: '' }]);
  const listIo = io({ run: list.run });
  assert.equal(testdbMain(['list'], listIo.options), 0);
  assert.ok(list.calls[0].includes(`label=${LABEL}`));
  assert.deepEqual(listIo.out, ['[testdb] none']);
});

test('usage errors and docker failures are reported', () => {
  const bad = io();
  assert.equal(testdbMain([], bad.options), 2);
  assert.equal(testdbMain(['down'], bad.options), 2);
  assert.equal(testdbMain(['up', '--name', 'x y', '--port', '55490'], bad.options), 2);
  const failing = fakeDocker([{ status: 1, stderr: 'port taken' }]);
  const failIo = io({ run: failing.run, wait: () => true });
  assert.equal(testdbMain(['up', '--name', 'db1', '--port', '55490'], failIo.options), 1);
  assert.match(failIo.err[0], /port taken/);
  const slow = io({ run: fakeDocker([{ status: 0 }]).run, wait: () => false });
  assert.equal(testdbMain(['up', '--name', 'db1', '--port', '55490'], slow.options), 1);
  const rm = io({ run: fakeDocker([{ status: 1, stderr: 'no such container' }]).run });
  assert.equal(testdbMain(['down', '--name', 'db1'], rm.options), 1);
  assert.equal(testdbMain(['list'], io({ run: fakeDocker([{ status: 1 }]).run }).options), 1);
});

test('shared servers use the documented per-project ports and restart with Docker', () => {
  const { sharedConfig, sharedUpArgs, SHARED_LABEL } = require('../lib/testdb');
  assert.deepEqual(sharedConfig('bc'), { port: 55432, user: 'billing', database: 'postgres', name: 'infra-testdb-bc' });
  assert.equal(sharedConfig('pc', { port: '55999', user: undefined }).port, '55999');
  assert.throws(() => sharedConfig('nope'), /unknown project/);
  const argv = sharedUpArgs(sharedConfig('worlio'));
  assert.deepEqual(argv.slice(0, 6), ['run', '-d', '--restart', 'unless-stopped', '--label', SHARED_LABEL]);
  assert.ok(argv.includes('127.0.0.1:55439:5432'));
  assert.ok(argv.includes('infra-testdb-worlio-data:/var/lib/postgresql/data'));
  assert.equal(argv.includes('--tmpfs'), false);
});

test('shared db creates once, reuses, drops, and validates names', () => {
  const states = [{ status: 0, stdout: 'true' }, { status: 0, stdout: '' }, { status: 0 }];
  const created = fakeDocker(states);
  const createdIo = io({ run: created.run, wait: () => true });
  assert.equal(testdbMain(['shared', 'db', '--project', 'pc', '--name', 'agent_a'], createdIo.options), 0);
  assert.deepEqual(createdIo.out, ['postgres://player:player@127.0.0.1:55444/agent_a']);
  assert.ok(created.calls[2].join(' ').includes('CREATE DATABASE agent_a'));
  const reused = fakeDocker([{ status: 0, stdout: 'true' }, { status: 0, stdout: '1' }]);
  assert.equal(testdbMain(['shared', 'db', '--project', 'pc', '--name', 'agent_a'], io({ run: reused.run, wait: () => true }).options), 0);
  assert.equal(reused.calls.length, 2);
  const dropped = fakeDocker([{ status: 0, stdout: 'true' }, { status: 0 }]);
  const dropIo = io({ run: dropped.run, wait: () => true });
  assert.equal(testdbMain(['shared', 'drop', '--project', 'pc', '--name', 'agent_a'], dropIo.options), 0);
  assert.ok(dropped.calls[1].join(' ').includes('DROP DATABASE IF EXISTS agent_a WITH (FORCE)'));
  assert.equal(testdbMain(['shared', 'db', '--project', 'pc', '--name', 'Bad'], io().options), 2);
  assert.equal(testdbMain(['shared', 'db', '--project', 'zz', '--name', 'a'], io().options), 2);
  assert.equal(testdbMain(['shared', 'oops', '--project', 'pc'], io().options), 2);
});

test('shared up starts a stopped server or creates a missing one, and down removes it', () => {
  const stopped = fakeDocker([{ status: 0, stdout: 'false' }, { status: 0 }]);
  const stoppedIo = io({ run: stopped.run, wait: () => true });
  assert.equal(testdbMain(['shared', 'up', '--project', 'bc'], stoppedIo.options), 0);
  assert.deepEqual(stopped.calls[1], ['docker', 'start', 'infra-testdb-bc']);
  assert.deepEqual(stoppedIo.out, ['postgres://billing:billing@127.0.0.1:55432/postgres']);
  const missing = fakeDocker([{ status: 1, stderr: 'no such object' }, { status: 0 }]);
  assert.equal(testdbMain(['shared', 'up', '--project', 'worlio'], io({ run: missing.run, wait: () => true }).options), 0);
  assert.equal(missing.calls[1][1], 'run');
  assert.equal(testdbMain(['shared', 'up', '--project', 'worlio'], io({ run: fakeDocker([{ status: 1 }, { status: 1, stderr: 'port busy' }]).run, wait: () => true }).options), 1);
  assert.equal(testdbMain(['shared', 'up', '--project', 'worlio'], io({ run: fakeDocker([{ status: 0, stdout: 'false' }, { status: 1, stderr: 'cannot start' }]).run, wait: () => true }).options), 1);
  assert.equal(testdbMain(['shared', 'up', '--project', 'worlio'], io({ run: fakeDocker([{ status: 0, stdout: 'false' }, { status: 0 }]).run, wait: () => false }).options), 1);
  assert.equal(testdbMain(['shared', 'db', '--project', 'pc', '--name', 'a'], io({ run: fakeDocker([{ status: 0, stdout: 'true' }, { status: 1, stderr: 'psql failed' }]).run, wait: () => true }).options), 1);
  assert.equal(testdbMain(['shared', 'db', '--project', 'pc', '--name', 'a'], io({ run: fakeDocker([{ status: 0, stdout: 'true' }, { status: 0, stdout: '' }, { status: 1, stderr: 'create failed' }]).run, wait: () => true }).options), 1);
  assert.equal(testdbMain(['shared', 'drop', '--project', 'pc', '--name', 'a'], io({ run: fakeDocker([{ status: 0, stdout: 'true' }, { status: 1, stderr: 'drop failed' }]).run, wait: () => true }).options), 1);
  const down = fakeDocker([{ status: 0 }]);
  assert.equal(testdbMain(['shared', 'down', '--project', 'pc'], io({ run: down.run }).options), 0);
  assert.deepEqual(down.calls[0], ['docker', 'rm', '-f', '-v', 'infra-testdb-pc']);
  assert.equal(testdbMain(['shared', 'down', '--project', 'pc'], io({ run: fakeDocker([{ status: 1, stderr: 'x' }]).run }).options), 1);
});
