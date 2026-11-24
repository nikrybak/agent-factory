// cli/lib/generators/gemini.js
const { header } = require('../header');

function genGemini() {
  return `${header('md')}\n@./AGENTS.md\n`;
}

module.exports = { genGemini };
