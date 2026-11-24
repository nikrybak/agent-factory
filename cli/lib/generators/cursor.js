// cli/lib/generators/cursor.js
const { header } = require('../header');

/**
 * Generate .cursor/rules/agents.md content.
 * Points Cursor at the canonical AGENTS.md via @AGENTS.md import.
 */
function genCursor() {
  return `${header('md')}\n# Cursor Rules\n\n@AGENTS.md\n\n<!-- This file is auto-generated. Edit AGENTS.md directly. -->\n`;
}

module.exports = { genCursor };
