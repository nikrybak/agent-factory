// cli/lib/doctor.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadCanon, resolveSkillsDir } = require('./load-canon');
const { readSkills } = require('./read-skills');
const { checkDrift } = require('./check');
const { validateSkills } = require('./validate');
const { MAP } = require('./targets');

// Heuristic patterns that may indicate a secret in prose.
// We match against lines, report location, but never print the matched value.
const SECRET_PATTERNS = [
  { label: 'TOKEN= assignment',    re: /TOKEN\s*=\s*\S{8,}/i },
  { label: 'secret= assignment',   re: /secret\s*[:=]\s*\S{8,}/i },
  { label: 'password= assignment', re: /password\s*[:=]\s*\S{8,}/i },
  { label: 'webhook URL',          re: /webhook[^\s]*https?:\/\/\S+/i },
  { label: 'long token-like value', re: /(?<![\/\w])([A-Za-z0-9_\-]{40,})(?!\w)/ },
];

function checkDriftIssues(canon, skills, outDir) {
  const issues = [];
  try {
    const { drifted, missing } = checkDrift(canon, skills, outDir);
    for (const f of drifted) issues.push({ level: 'error', msg: `drift: generated file differs from canon: ${f}` });
    for (const f of missing) issues.push({ level: 'error', msg: `missing: generated file not found: ${f}` });
  } catch (e) {
    issues.push({ level: 'error', msg: `drift check failed: ${e.message}` });
  }
  return issues;
}

function checkSkillsIssues(skillsDir, include) {
  const issues = [];
  try {
    const problems = validateSkills(skillsDir, include);
    for (const { skill, problem } of problems) {
      issues.push({ level: 'error', msg: `skill ${skill}: ${problem}` });
    }
  } catch (e) {
    issues.push({ level: 'error', msg: `skills validation failed: ${e.message}` });
  }
  return issues;
}

function checkTargetCoverage(targets) {
  const issues = [];
  for (const t of (targets || [])) {
    if (!MAP[t]) {
      issues.push({ level: 'warn', msg: `target '${t}' has no MAP entry and will be skipped` });
    }
  }
  return issues;
}

function scanFileForSecrets(filePath, label) {
  const issues = [];
  if (!fs.existsSync(filePath)) return issues;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return issues; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of SECRET_PATTERNS) {
      if (pat.re.test(line)) {
        issues.push({
          level: 'warn',
          msg: `possible secret in ${label} line ${i + 1}: ${pat.label} (value not shown)`,
        });
        break; // one warn per line
      }
    }
  }
  return issues;
}

function checkSecretsHygiene(fromDir) {
  const issues = [];
  const localJson = path.join(fromDir, 'agents.local.json');
  if (fs.existsSync(localJson)) {
    issues.push({ level: 'info', msg: 'agents.local.json exists — ensure it is listed in .gitignore' });
  }
  issues.push(...scanFileForSecrets(path.join(fromDir, 'agents.json'), 'agents.json'));
  issues.push(...scanFileForSecrets(path.join(fromDir, 'AGENTS.md'), 'AGENTS.md'));
  return issues;
}

/**
 * Run diagnostic checks against the canon repo at fromDir / generated files at outDir.
 * Returns { issues: Array<{ level: 'error'|'warn'|'info', msg: string }>, ok: boolean }
 * ok === true iff no 'error'-level issues.
 */
function doctor(fromDir, outDir) {
  const issues = [];

  // Load canon — hard error if missing
  let canon, skills;
  try {
    canon = loadCanon(fromDir);
    skills = readSkills(resolveSkillsDir(fromDir, canon.config));
  } catch (e) {
    issues.push({ level: 'error', msg: `cannot load canon: ${e.message}` });
    return { issues, ok: false };
  }

  // 1. Drift
  issues.push(...checkDriftIssues(canon, skills, outDir));

  // 2. Skills validation
  const skillsDir = resolveSkillsDir(fromDir, canon.config);
  issues.push(...checkSkillsIssues(skillsDir, canon.config.canon.skillsInclude));

  // 3. Target coverage
  issues.push(...checkTargetCoverage(canon.config.targets));

  // 4. Secrets hygiene
  issues.push(...checkSecretsHygiene(fromDir));

  return { issues, ok: !issues.some(i => i.level === 'error') };
}

module.exports = { doctor };
