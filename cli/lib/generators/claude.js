// cli/lib/generators/claude.js
const { header } = require('../header');

function genClaude() {
  return `${header('md')}\n# CLAUDE.md\n\n@AGENTS.md\n`;
}

module.exports = { genClaude };
