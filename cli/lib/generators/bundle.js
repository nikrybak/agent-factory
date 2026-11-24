// cli/lib/generators/bundle.js
function genBundle(canon, skills) {
  const idx = (skills || []).map(s => `- ${s.name} — ${s.description || ''}`).join('\n');
  return `${canon.agentsMd}\n\n## Skills\n\n${idx}\n`;
}

module.exports = { genBundle };
