// cli/lib/sync.js
const fs = require('node:fs');
const path = require('node:path');
const { MAP } = require('./targets');

function planTargets(canon, skills) {
  return (canon.config.targets || [])
    .filter(t => MAP[t])
    .map(t => MAP[t](canon, skills));
}

function syncTargets(canon, skills, outDir) {
  const plan = planTargets(canon, skills);
  for (const { relPath, content } of plan) {
    const dest = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return plan.map(p => p.relPath);
}

module.exports = { planTargets, syncTargets };
