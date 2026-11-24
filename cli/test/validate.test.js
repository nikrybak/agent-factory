// cli/test/validate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSkills } = require('../lib/validate');

function mkSkill(root, name, body) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

test('validateSkills flags missing name and broken reference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  mkSkill(root, 'good', '---\nname: good\ndescription: ok\n---\nbody');
  mkSkill(root, 'bad', '---\ndescription: no name\n---\nsee reference/missing.md');
  const issues = validateSkills(root);
  const probs = issues.map(i => `${i.skill}:${i.problem}`).join('|');
  assert.match(probs, /bad:.*name/);
  assert.match(probs, /bad:.*reference\/missing\.md/);
  assert.ok(!probs.includes('good:'));
});

test('validateSkills flags name longer than 64 chars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  mkSkill(root, 'longname', '---\nname: ' + 'x'.repeat(65) + '\ndescription: ok\n---\nbody');
  const probs = validateSkills(root).map(i => `${i.skill}:${i.problem}`).join('|');
  assert.match(probs, /longname:.*name.*64/);
});

test('validateSkills flags description longer than 1024 chars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  mkSkill(root, 'longdesc', '---\nname: ok\ndescription: ' + 'x'.repeat(1025) + '\n---\nbody');
  const probs = validateSkills(root).map(i => `${i.skill}:${i.problem}`).join('|');
  assert.match(probs, /longdesc:.*description.*1024/);
});

test('validateSkills flags a directory without SKILL.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  fs.mkdirSync(path.join(root, 'empty'));
  const probs = validateSkills(root).map(i => `${i.skill}:${i.problem}`).join('|');
  assert.match(probs, /empty:.*missing SKILL\.md/);
});

// The canon now lives outside the repo, so a missing directory means a misconfigured path rather
// than "nothing to check". Returning [] made `infra validate` pass while validating nothing.
test('validateSkills reports a missing directory instead of passing silently', () => {
  const issues = validateSkills(path.join(os.tmpdir(), 'no-such-skills-zzz-987'));
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0].problem, /skills directory not found/);
});

test('validateSkills honours the include list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  for (const n of ['wanted', 'ignored']) {
    fs.mkdirSync(path.join(root, n));
    fs.writeFileSync(path.join(root, n, 'SKILL.md'), `---\nname: ${n}\n---\nbody\n`);
  }
  // 'ignored' has no description and would be flagged if it were in scope.
  const flagged = validateSkills(root, ['wanted']).map(i => i.skill);
  assert.ok(!flagged.includes('ignored'), 'skills outside the include list must not be validated');
});

// GEN-4: URL in prose must NOT be flagged as a broken reference
test('validateSkills does not flag https URLs containing "reference" as broken', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  // prose body contains a URL that has "reference" in the path
  const body = '---\nname: urltest\ndescription: ok\n---\n' +
    'See https://example.com/reference/api for details.\n' +
    'Also https://docs.site/references/guide works.\n';
  mkSkill(root, 'urltest', body);
  const issues = validateSkills(root);
  const probs = issues.map(i => i.problem).join('|');
  assert.ok(!probs.includes('broken reference'), `URL should not be flagged; got: ${probs}`);
});

// GEN-4: a real relative reference to a missing file IS still flagged
test('validateSkills flags a relative reference to a missing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  mkSkill(root, 'relref', '---\nname: relref\ndescription: ok\n---\nsee reference/missing.md here');
  const issues = validateSkills(root);
  const probs = issues.map(i => i.problem).join('|');
  assert.ok(probs.includes('broken reference reference/missing.md'), `Expected broken reference; got: ${probs}`);
});

// GEN-4: an existing references/x.md is NOT flagged
test('validateSkills does not flag an existing references file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const skillDir = path.join(root, 'present');
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: present\ndescription: ok\n---\nsee references/x.md');
  fs.writeFileSync(path.join(skillDir, 'references', 'x.md'), '# ref');
  const issues = validateSkills(root);
  assert.deepStrictEqual(issues, []);
});

test('validateSkills supports Unicode reference names and ignores explicitly absent hubs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const skill = path.join(root, 'unicode');
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'references', 'схема.md'), '# ref');
  fs.writeFileSync(path.join(skill, 'SKILL.md'), [
    '---', 'name: unicode', 'description: ok', '---',
    'Read references/схема.md.', 'There is no `references/index.md` hub.',
  ].join('\n'));
  assert.deepStrictEqual(validateSkills(root), []);
});

test('validateSkills checks reference files while accepting anchors, Markdown suffixes and templates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const skill = path.join(root, 'references');
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'references', 'guide.md'), '# guide');
  fs.writeFileSync(path.join(skill, 'SKILL.md'), [
    '---', 'name: references', 'description: ok', '---',
    'Read references/guide.md#section and **references/guide.md**.',
    'Use references/items-*.md and references/path/<name>.md as templates.',
  ].join('\n'));
  assert.deepStrictEqual(validateSkills(root), []);
});
