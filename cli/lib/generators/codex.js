// cli/lib/generators/codex.js
const { header } = require('../header');
const { mcpTable } = require('../to-toml');

function genCodex(canon) {
  const servers = canon.config.mcpServers || {};
  const tables = Object.entries(servers).map(([n, d]) => mcpTable(n, d));
  return [
    header('toml'),
    'persistent_instructions = "Follow project AGENTS.md."',
    '',
    ...tables
  ].join('\n') + '\n';
}

module.exports = { genCodex };
