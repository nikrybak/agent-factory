'use strict';

/**
 * Throwaway PostgreSQL for tests (ADR-0021): data in memory (tmpfs) and durability switched off,
 * which makes per-test databases and migrations several times faster. Never for real data.
 * Containers are labelled `infra.testdb=1` so `list` finds them and `down` removes them with volumes.
 */

const { spawnSync } = require('node:child_process');

const LABEL = 'infra.testdb=1';
const NAME = /^[a-z0-9][a-z0-9_.-]{1,62}$/;
const FAST_FLAGS = [
  '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
  '-c', 'max_connections=400', '-c', 'shared_buffers=256MB', '-c', 'max_wal_size=2GB',
];

function upArgs({ name, port, image = 'postgres:17', user = 'player', database = 'player_schema', tmpfsSize = '2g' }) {
  if (!NAME.test(name)) throw new Error(`invalid container name '${name}'`);
  const portNumber = Number.parseInt(port, 10);
  if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) throw new Error(`invalid port '${port}'`);
  return [
    'run', '-d', '--name', name, '--label', LABEL, '-p', `127.0.0.1:${portNumber}:5432`,
    '--tmpfs', `/var/lib/postgresql/data:rw,size=${tmpfsSize}`,
    // Test-only credentials for a loopback-bound throwaway server.
    '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${user}`, '-e', `POSTGRES_DB=${database}`,
    image, ...FAST_FLAGS,
  ];
}

function docker(args, run = spawnSync) {
  const result = run('docker', args, { encoding: 'utf8', shell: false });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

function waitReady(name, { run = spawnSync, attempts = 60, sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (docker(['exec', name, 'pg_isready', '-q'], run).ok) return true;
    sleep(500);
  }
  return false;
}

/**
 * Shared servers (owner decision 2026-10-06): one long-lived fast server per project instead of a
 * container per agent. Test harnesses (`sqlx::test`, Testcontainers-free JVM tests) create their own
 * databases on it; agents get a private database with `shared db`. Ports and credentials are test-only.
 */
const SHARED_PROJECTS = Object.freeze({
  // The ports and credentials each repository already documents for its test database, so repository
  // scripts and docs keep working unchanged against the shared server.
  pc: { port: 55444, user: 'player', database: 'player_schema' },
  bc: { port: 55432, user: 'billing', database: 'postgres' },
  worlio: { port: 55439, user: 'postgres', database: 'postgres' },
});
const SHARED_LABEL = 'infra.testdb.shared=1';
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function sharedConfig(project, overrides = {}) {
  const base = SHARED_PROJECTS[project];
  if (!base) throw new Error(`unknown project '${project}' (expected ${Object.keys(SHARED_PROJECTS).join(', ')})`);
  return { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value)), name: `infra-testdb-${project}` };
}

function sharedUpArgs(config) {
  const argv = upArgs(config);
  // The schema-only databases (`sqlx` compile-time checks: billing_schema, player_schema) must survive Docker
  // and host restarts, so shared servers keep their data in a named volume instead of tmpfs. Durability stays
  // off (fsync, synchronous_commit), so writes still go to the page cache and run at near-memory speed.
  const tmpfs = argv.indexOf('--tmpfs');
  argv.splice(tmpfs, 2, '-v', `${config.name}-data:/var/lib/postgresql/data`);
  argv.splice(2, 0, '--restart', 'unless-stopped', '--label', SHARED_LABEL);
  return argv;
}

function psql(config, sql, run) {
  return docker(['exec', config.name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', config.user, '-d', config.database, '-tAc', sql], run);
}

function ensureShared(config, { run, wait }) {
  const state = docker(['inspect', '-f', '{{.State.Running}}', config.name], run);
  if (state.ok && state.out === 'true') return { ok: true };
  if (state.ok) {
    const start = docker(['start', config.name], run);
    if (!start.ok) return { ok: false, error: start.err };
  } else {
    const created = docker(sharedUpArgs(config), run);
    if (!created.ok) return { ok: false, error: created.err };
  }
  return wait(config.name, { run }) ? { ok: true } : { ok: false, error: `${config.name} did not become ready` };
}

function url(config, database) {
  return `postgres://${config.user}:${config.user}@127.0.0.1:${config.port}/${database}`;
}

function sharedMain(rest, { out, err, run, wait }) {
  const [action, ...options] = rest;
  const value = flag => { const index = options.indexOf(flag); return index >= 0 ? options[index + 1] : undefined; };
  let config;
  try {
    config = sharedConfig(value('--project'), { user: value('--user'), database: value('--db'), port: value('--port') });
  } catch (error) { err(`[testdb] ${error.message}`); err(USAGE); return 2; }
  if (action === 'down') {
    const result = docker(['rm', '-f', '-v', config.name], run);
    if (!result.ok) { err(`[testdb] ${result.err}`); return 1; }
    out(`[testdb] removed ${config.name}`);
    return 0;
  }
  if (!['up', 'db', 'drop'].includes(action)) { err(USAGE); return 2; }
  const name = value('--name');
  if (action !== 'up' && (!name || !DB_NAME.test(name))) { err('[testdb] --name must match [a-z][a-z0-9_]*'); return 2; }
  const ready = ensureShared(config, { run, wait });
  if (!ready.ok) { err(`[testdb] ${ready.error}`); return 1; }
  if (action === 'up') { out(url(config, config.database)); return 0; }
  if (action === 'drop') {
    const dropped = psql(config, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, run);
    if (!dropped.ok) { err(`[testdb] ${dropped.err}`); return 1; }
    out(`[testdb] dropped ${name}`);
    return 0;
  }
  const exists = psql(config, `SELECT 1 FROM pg_database WHERE datname = '${name}'`, run);
  if (!exists.ok) { err(`[testdb] ${exists.err}`); return 1; }
  if (exists.out !== '1') {
    const created = psql(config, `CREATE DATABASE ${name}`, run);
    if (!created.ok) { err(`[testdb] ${created.err}`); return 1; }
  }
  out(url(config, name));
  return 0;
}

const USAGE = 'usage: infra testdb <shared <up|db|drop|down> --project pc|bc|worlio [--name DB] [--user U] [--db D] [--port P] | up --name N --port P [--image I] [--user U] [--db D] | down --name N | list>';

function testdbMain(args, { out = console.log, err = console.error, run = spawnSync, wait = waitReady } = {}) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'shared') return sharedMain(rest, { out, err, run, wait });
  const value = flag => { const index = rest.indexOf(flag); return index >= 0 ? rest[index + 1] : undefined; };
  if (subcommand === 'list') {
    const result = docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'], run);
    out(result.out || '[testdb] none');
    return result.ok ? 0 : 1;
  }
  if (subcommand === 'down') {
    const name = value('--name');
    if (!name || !NAME.test(name)) { err(USAGE); return 2; }
    const result = docker(['rm', '-f', '-v', name], run);
    if (!result.ok) { err(`[testdb] ${result.err}`); return 1; }
    out(`[testdb] removed ${name}`);
    return 0;
  }
  if (subcommand === 'up') {
    let argv;
    try {
      argv = upArgs({ name: value('--name'), port: value('--port'), image: value('--image'), user: value('--user'), database: value('--db') });
    } catch (error) { err(`[testdb] ${error.message}`); err(USAGE); return 2; }
    const result = docker(argv, run);
    if (!result.ok) { err(`[testdb] ${result.err}`); return 1; }
    const name = value('--name');
    if (!wait(name, { run })) { err(`[testdb] ${name} did not become ready`); return 1; }
    const user = value('--user') || 'player';
    out(`postgres://${user}:${user}@127.0.0.1:${value('--port')}/${value('--db') || 'player_schema'}`);
    return 0;
  }
  err(USAGE);
  return 2;
}

module.exports = { FAST_FLAGS, LABEL, SHARED_LABEL, SHARED_PROJECTS, USAGE, sharedConfig, sharedUpArgs, testdbMain, upArgs, waitReady };
