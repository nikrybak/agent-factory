// cli/lib/validate.js
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./read-skills');

function referencedPaths(text) {
  const paths = [];
  for (const match of text.matchAll(/(?<![\/:\w])(references?\/[^\s)\]>"'`]+)/gu)) {
    const before = text.slice(0, match.index);
    // A sentence such as "no `references/index.md` hub" documents a deliberate
    // absence, not a broken dependency. URLs are excluded by the lookbehind.
    if (/\b(?:no|not|without)\s+`?$/iu.test(before)) continue;
    const reference = match[0].split('#', 1)[0].replace(/[*,.;:]+$/u, '');
    // Templates and globs document a family of files, not a concrete on-disk
    // dependency that the validator can resolve.
    if (!reference || reference.includes('<') || reference.includes('*')) continue;
    paths.push(reference);
  }
  return paths;
}

function validateSkills(skillsDir, include) {
  const issues = [];
  // A missing directory used to pass silently, so `validate` reported success when the canon
  // was simply absent. With the canon outside the repo, that false green would hide a
  // misconfigured path entirely.
  if (!fs.existsSync(skillsDir)) {
    issues.push({ skill: '(canon)', problem: `skills directory not found: ${skillsDir}` });
    return issues;
  }
  // The canon is a shared store; only the names this base declares are its concern. An empty
    // list still means "all", so a plain project-local canon behaves as before.
    const wanted = Array.isArray(include) && include.length > 0 ? new Set(include) : null;
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === '.git' || d.name.startsWith('.')) continue;
      if (wanted && !wanted.has(d.name)) continue;
    const skillDir = path.join(skillsDir, d.name);
    const md = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(md)) { issues.push({ skill: d.name, problem: 'missing SKILL.md' }); continue; }
    const text = fs.readFileSync(md, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm.name) issues.push({ skill: d.name, problem: 'missing frontmatter name' });
    else if (fm.name.length > 64) issues.push({ skill: d.name, problem: 'name exceeds 64 chars' });
    if (!fm.description) issues.push({ skill: d.name, problem: 'missing frontmatter description' });
    else if (fm.description.length > 1024) issues.push({ skill: d.name, problem: 'description exceeds 1024 chars' });
    for (const reference of referencedPaths(text)) {
      if (!fs.existsSync(path.join(skillDir, reference))) issues.push({ skill: d.name, problem: `broken reference ${reference}` });
    }
  }
  return issues;
}

module.exports = { validateSkills, referencedPaths };
