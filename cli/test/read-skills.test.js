const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSkills, parseFrontmatter } = require('../lib/read-skills');

function mkSkill(root, name, body) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

test('parseFrontmatter handles CRLF line endings', () => {
  const fm = parseFrontmatter('---\r\nname: a\r\ndescription: b\r\n---\r\nbody');
  assert.strictEqual(fm.name, 'a');
  assert.strictEqual(fm.description, 'b');
});

test('parseFrontmatter preserves folded multi-line descriptions', () => {
  const fm = parseFrontmatter([
    '---',
    'name: mobile-skill',
    'description:',
    '  Use when Android or iOS work needs',
    '  an explicit platform verification lane.',
    'metadata:',
    '  owner: example',
    '---',
  ].join('\n'));
  assert.strictEqual(fm.name, 'mobile-skill');
  assert.strictEqual(fm.description, 'Use when Android or iOS work needs an explicit platform verification lane.');
});

test('readSkills returns [] for a missing directory', () => {
  assert.deepStrictEqual(readSkills(path.join(os.tmpdir(), 'no-such-dir-xyz-123')), []);
});

test('readSkills skips a dir without SKILL.md and a skill without name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  fs.mkdirSync(path.join(root, 'empty'));
  mkSkill(root, 'noname', '---\ndescription: x\n---\nbody');
  mkSkill(root, 'good', '---\nname: good\ndescription: ok\n---\nbody');
  assert.deepStrictEqual(readSkills(root), [{ name: 'good', description: 'ok' }]);
});
