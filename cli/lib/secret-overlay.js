// cli/lib/secret-overlay.js
// GEN-2: write a gitignored config.local.toml for secret-bearing local MCP servers.
// The committed config.toml must stay secret-free; this file is never committed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { header } = require('./header');
const { mcpTable } = require('./to-toml');

/**
 * Load agents.local.json if it exists. Returns null when absent.
 * @param {string} fromDir - canon root directory
 * @returns {{ mcpServers: Object } | null}
 */
function loadLocalAgents(fromDir) {
  const localPath = path.join(fromDir, 'agents.local.json');
  if (!fs.existsSync(localPath)) return null;
  try {
    const raw = fs.readFileSync(localPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.mcpServers === 'object' ? parsed : null;
  } catch (e) {
    process.stderr.write(`[infra] agents.local.json parse error (skipping): ${e.message}\n`);
    return null;
  }
}

/**
 * Build TOML content for config.local.toml from local MCP servers.
 * @param {{ [name: string]: object }} servers
 * @returns {string}
 */
function buildLocalToml(servers) {
  const tables = Object.entries(servers).map(([n, d]) => mcpTable(n, d));
  return [
    header('toml') + ' (LOCAL — never commit)',
    '# Secret-bearing local MCP servers. Gitignored via *.local.toml.',
    '',
    ...tables,
  ].join('\n') + '\n';
}

/**
 * Write <outDir>/.codex/config.local.toml from agents.local.json if present.
 * Does nothing if agents.local.json is absent.
 * @param {string} fromDir - canon root
 * @param {string} outDir  - sync output root
 * @returns {boolean} true if file was written, false if skipped
 */
function writeSecretOverlay(fromDir, outDir) {
  const local = loadLocalAgents(fromDir);
  if (!local) return false;
  const servers = local.mcpServers || {};
  if (Object.keys(servers).length === 0) return false;
  const content = buildLocalToml(servers);
  const dest = path.join(outDir, '.codex', 'config.local.toml');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return true;
}

module.exports = { loadLocalAgents, buildLocalToml, writeSecretOverlay };
