// cli/lib/load-canon.js
const fs = require('node:fs');
const path = require('node:path');

function loadCanon(fromDir) {
  const root = path.resolve(fromDir);
  const agentsPath = path.join(root, 'AGENTS.md');
  const cfgPath = path.join(root, 'agents.json');
  if (!fs.existsSync(agentsPath)) throw new Error(`[infra] AGENTS.md not found in ${root}`);
  if (!fs.existsSync(cfgPath)) throw new Error(`[infra] agents.json not found in ${root}`);
  const agentsMd = fs.readFileSync(agentsPath, 'utf8');
  let config;
  try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { throw new Error(`[infra] agents.json is not valid JSON: ${e.message}`); }
  return { agentsMd, config, root };
}


/**
 * Resolve the canonical skills directory.
 *
 * A City Fabric canon normally uses the repository-local `skills/` directory so
 * a clone contains the exact gates it declares. Relative paths remain portable;
 * the expansion support preserves compatibility for an explicitly configured
 * external read-only canon.
 */
function resolveSkillsDir(fromDir, config) {
  const raw = (config && config.canon && config.canon.skills) || 'skills';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const expanded = raw.startsWith('~/') || raw.startsWith('~\\')
    ? path.join(home, raw.slice(2))
    : raw;
  return path.resolve(fromDir, expanded);
}

module.exports = { loadCanon, resolveSkillsDir };
