// cli/lib/check.js
const fs = require('node:fs');
const path = require('node:path');
const { planTargets } = require('./sync');

function checkDrift(canon, skills, outDir) {
  const drifted = [], missing = [];
  for (const { relPath, content } of planTargets(canon, skills)) {
    const dest = path.join(outDir, relPath);
    if (!fs.existsSync(dest)) { missing.push(relPath); continue; }
    if (fs.readFileSync(dest, 'utf8') !== content) drifted.push(relPath);
  }
  return { drifted, missing };
}

module.exports = { checkDrift };
