// cli/lib/skills-sync.js
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./read-skills');

/**
 * Normalise the third argument into an array of spec objects.
 * Callers may pass:
 *   - nothing/undefined → default destSpecs
 *   - array of strings  → backward-compat: each string becomes { dir }
 *   - array of specs    → used as-is
 *
 * Default specs:
 *   .claude/skills  — no byte cap (full copy)
 *   .agents/skills  — maxBytes: 8192 (Codex 8 KB limit)
 */
function normaliseSpecs(arg) {
  if (!arg) {
    return [
      { dir: '.claude/skills' },
      { dir: '.agents/skills', maxBytes: 8192 },
    ];
  }
  return arg.map(item => (typeof item === 'string' ? { dir: item } : item));
}

function resolveMirrorRoot(outDir, dir) {
  const root = path.resolve(outDir);
  const target = path.resolve(root, ...dir.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`[infra] unsafe generated skills destination: ${dir}`);
  }
  return target;
}

/**
 * Extract the YAML frontmatter block from text (everything between the
 * first pair of `---` fences, inclusive).  Returns '' if none found.
 */
function extractFrontmatterBlock(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return m ? m[0] : '';
}

/**
 * Split a skill file that exceeds maxBytes for the Codex copy.
 * Writes a thinned SKILL.md (frontmatter + pointer) and the full content
 * to references/_full.md inside destSkillDir.
 */
function splitSkillIfNeeded(src, destSkillDir, maxBytes) {
  const buf = fs.readFileSync(src);
  if (buf.length <= maxBytes) return; // nothing to do

  const text = buf.toString('utf8');
  const fm = extractFrontmatterBlock(text);
  const pointer =
    '> Полное тело вынесено в references/_full.md (split под лимит Codex 8KB).';
  const thinned = fm ? `${fm}\n\n${pointer}\n` : `${pointer}\n`;

  // Safety: thinned must itself be < maxBytes (it always will be, but guard anyway)
  if (Buffer.byteLength(thinned, 'utf8') > maxBytes) {
    process.stderr.write(
      `[infra] warn: thinned SKILL.md in ${destSkillDir} still exceeds ${maxBytes} bytes\n`
    );
  }

  // Write thinned SKILL.md in place
  fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), thinned, 'utf8');

  // Write full content to references/_full.md
  const refsDir = path.join(destSkillDir, 'references');
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(refsDir, '_full.md'), text, 'utf8');
}

/**
 * Copy every <name>/ subdirectory of skillsDir that contains a SKILL.md into
 * each dest spec directory (resolved under outDir).
 *
 * destSpecs default:
 *   [{ dir: '.claude/skills' }, { dir: '.agents/skills', maxBytes: 8192 }]
 *
 * Backward-compat: if destSpecs is an array of strings each is treated as
 * { dir: string } (no byte cap).
 *
 * For a spec with maxBytes set, any copied SKILL.md that exceeds that limit is
 * split: the YAML frontmatter is preserved, the body is replaced with a pointer
 * line, and the original full content is written to references/_full.md.
 *
 * Returns a sorted list of skill names copied. [] if skillsDir is missing.
 */
function syncSkills(skillsDir, outDir, destSpecs, include) {
  if (!fs.existsSync(skillsDir)) return [];

  const specs = normaliseSpecs(destSpecs);
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  // Only the names this base declares; an empty list still means "all".
  const wanted = Array.isArray(include) && include.length > 0 ? new Set(include) : null;
  const names = [];

  // Mirrors are generated artifacts. Rebuild them so a skill removed from the
  // canonical directory cannot survive as a stale, still-discoverable capability.
  for (const spec of specs) {
    const mirrorRoot = resolveMirrorRoot(outDir, spec.dir);
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
    fs.mkdirSync(mirrorRoot, { recursive: true });
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;

    if (wanted && !wanted.has(entry.name)) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    for (const spec of specs) {
      const dest = path.join(resolveMirrorRoot(outDir, spec.dir), entry.name);
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(path.join(skillsDir, entry.name), dest, { recursive: true });

      if (spec.maxBytes) {
        splitSkillIfNeeded(skillMd, dest, spec.maxBytes);
      }
    }
    names.push(entry.name);
  }

  return names.sort();
}

module.exports = { syncSkills };
