// cli/lib/read-skills.js
const fs = require('node:fs');
const path = require('node:path');

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const kv = lines[index].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    const [key, rawValue] = [kv[1], kv[2].trim()];
    const continuation = [];
    while (index + 1 < lines.length && /^\s+\S/u.test(lines[index + 1])) {
      continuation.push(lines[index + 1].trim());
      index += 1;
    }
    const value = rawValue === '|' ? continuation.join('\n') : [rawValue, ...continuation].filter(Boolean).join(' ');
    out[key] = value.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function readSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(skillsDir, d.name, 'SKILL.md'))
    .filter(p => fs.existsSync(p))
    .map(p => parseFrontmatter(fs.readFileSync(p, 'utf8')))
    .filter(fm => fm.name);
}

module.exports = { readSkills, parseFrontmatter };
