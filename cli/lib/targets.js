// cli/lib/targets.js
const { genClaude } = require('./generators/claude');
const { genGemini } = require('./generators/gemini');
const { genCodex } = require('./generators/codex');
const { genBundle } = require('./generators/bundle');
const { genCursor } = require('./generators/cursor');

const MAP = {
  claude:  (c) => ({ relPath: 'CLAUDE.md', content: genClaude(c) }),
  gemini:  (c) => ({ relPath: 'GEMINI.md', content: genGemini(c) }),
  codex:   (c) => ({ relPath: '.codex/config.toml', content: genCodex(c) }),
  bundle:  (c, skills) => ({ relPath: 'context-bundle.md', content: genBundle(c, skills) }),
  cursor:  (c) => ({ relPath: '.cursor/rules/agents.md', content: genCursor(c) }),
};

module.exports = { MAP };
