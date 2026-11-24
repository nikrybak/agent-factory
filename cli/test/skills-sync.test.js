// cli/test/skills-sync.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncSkills } = require('../lib/skills-sync');

test('syncSkills returns [] for a missing skillsDir', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const result = syncSkills(path.join(os.tmpdir(), 'no-such-skills-xyz'), out);
  assert.deepStrictEqual(result, []);
});

test('syncSkills copies SKILL.md and nested files, returns sorted names', () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));

  // skill foo with a SKILL.md and nested references/x.md
  fs.mkdirSync(path.join(skillsDir, 'foo', 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'foo', 'SKILL.md'), '# foo skill');
  fs.writeFileSync(path.join(skillsDir, 'foo', 'references', 'x.md'), '# ref x');

  // skill bar with only SKILL.md
  fs.mkdirSync(path.join(skillsDir, 'bar'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'bar', 'SKILL.md'), '# bar skill');

  // a dir without SKILL.md — should be skipped
  fs.mkdirSync(path.join(skillsDir, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'ignored', 'README.md'), '# not a skill');

  const result = syncSkills(skillsDir, out);

  assert.deepStrictEqual(result, ['bar', 'foo']);

  // SKILL.md copied
  assert.ok(fs.existsSync(path.join(out, '.claude', 'skills', 'foo', 'SKILL.md')));
  assert.strictEqual(
    fs.readFileSync(path.join(out, '.claude', 'skills', 'foo', 'SKILL.md'), 'utf8'),
    '# foo skill'
  );

  // nested file copied
  assert.ok(fs.existsSync(path.join(out, '.claude', 'skills', 'foo', 'references', 'x.md')));

  // bar copied
  assert.ok(fs.existsSync(path.join(out, '.claude', 'skills', 'bar', 'SKILL.md')));

  // also materialized to .agents/skills for Codex/generic SKILL.md tools
  assert.ok(fs.existsSync(path.join(out, '.agents', 'skills', 'foo', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(out, '.agents', 'skills', 'foo', 'references', 'x.md')));

  // ignored not copied
  assert.ok(!fs.existsSync(path.join(out, '.claude', 'skills', 'ignored')));
});

// SKILL-3: oversized SKILL.md is split for .agents/skills but not for .claude/skills
test('syncSkills splits oversized SKILL.md in capped dest only', () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));

  // Build a skill whose SKILL.md is >8KB
  const frontmatter = '---\nname: big-skill\ndescription: a large skill\n---\n';
  // 9000 bytes of body (well over 8192)
  const body = 'x'.repeat(9000);
  const fullContent = frontmatter + body;
  fs.mkdirSync(path.join(skillsDir, 'big-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'big-skill', 'SKILL.md'), fullContent, 'utf8');

  syncSkills(skillsDir, out);

  // .claude/skills copy must remain full/unsplit
  const claudeSkill = path.join(out, '.claude', 'skills', 'big-skill', 'SKILL.md');
  const claudeContent = fs.readFileSync(claudeSkill, 'utf8');
  assert.strictEqual(claudeContent, fullContent, '.claude copy should be full');

  // .agents/skills copy must be <= 8192 bytes
  const agentsSkill = path.join(out, '.agents', 'skills', 'big-skill', 'SKILL.md');
  const agentsBuf = fs.readFileSync(agentsSkill);
  assert.ok(agentsBuf.length <= 8192, `.agents SKILL.md must be ≤8192 bytes, got ${agentsBuf.length}`);

  // .agents SKILL.md must contain the frontmatter
  const agentsContent = agentsBuf.toString('utf8');
  assert.ok(agentsContent.includes('name: big-skill'), '.agents SKILL.md must preserve frontmatter');

  // references/_full.md must exist with the full original content
  const fullRef = path.join(out, '.agents', 'skills', 'big-skill', 'references', '_full.md');
  assert.ok(fs.existsSync(fullRef), 'references/_full.md must be created for oversized skill');
  assert.strictEqual(fs.readFileSync(fullRef, 'utf8'), fullContent, '_full.md must contain original content');
});

// SKILL-3: small skills are NOT split (no references/_full.md created)
test('syncSkills does NOT split small SKILL.md in capped dest', () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));

  const content = '---\nname: tiny\ndescription: small skill\n---\nshort body\n';
  fs.mkdirSync(path.join(skillsDir, 'tiny'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'tiny', 'SKILL.md'), content, 'utf8');

  syncSkills(skillsDir, out);

  // .agents/skills copy is untouched and no _full.md created
  const agentsSkill = path.join(out, '.agents', 'skills', 'tiny', 'SKILL.md');
  assert.strictEqual(fs.readFileSync(agentsSkill, 'utf8'), content);
  assert.ok(!fs.existsSync(path.join(out, '.agents', 'skills', 'tiny', 'references', '_full.md')));
});

// SKILL-3: backward-compat with string array destSpecs
test('syncSkills accepts legacy string array and applies no byte cap', () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));

  const content = '---\nname: big2\ndescription: big\n---\n' + 'y'.repeat(9000);
  fs.mkdirSync(path.join(skillsDir, 'big2'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'big2', 'SKILL.md'), content, 'utf8');

  // Pass legacy string array — no maxBytes → no split
  syncSkills(skillsDir, out, ['custom/skills']);

  const dest = path.join(out, 'custom', 'skills', 'big2', 'SKILL.md');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), content);
  assert.ok(!fs.existsSync(path.join(out, 'custom', 'skills', 'big2', 'references', '_full.md')));
});

test('syncSkills prunes skills removed from the canonical directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-prune-'));
  const skillsDir = path.join(root, 'skills');
  const out = path.join(root, 'out');

  for (const name of ['keep', 'remove']) {
    fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\n`,
      'utf8'
    );
  }
  syncSkills(skillsDir, out);

  fs.rmSync(path.join(skillsDir, 'remove'), { recursive: true, force: true });
  syncSkills(skillsDir, out);

  for (const mirror of ['.claude/skills', '.agents/skills']) {
    assert.equal(fs.existsSync(path.join(out, mirror, 'keep', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(out, mirror, 'remove')), false);
  }
});

test('syncSkills rejects a mirror destination outside outDir without deleting it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-safe-'));
  const skillsDir = path.join(root, 'skills');
  const out = path.join(root, 'out');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(skillsDir, 'safe'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'safe', 'SKILL.md'), '# safe', 'utf8');
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve', 'utf8');

  assert.throws(
    () => syncSkills(skillsDir, out, ['../outside']),
    /unsafe generated skills destination/
  );
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'preserve');
});
