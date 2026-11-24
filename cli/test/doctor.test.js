// cli/test/doctor.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { doctor } = require('../lib/doctor');
const { syncTargets } = require('../lib/sync');
const { syncSkills } = require('../lib/skills-sync');

/** Create a minimal valid fixture with canon + synced output. */
function makeFixture(opts) {
  opts = opts || {};
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-from-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-out-'));

  // AGENTS.md
  fs.writeFileSync(path.join(from, 'AGENTS.md'), '# Contract\nSome content.');

  // agents.json with a clean config
  const cfg = {
    version: '1.0',
    canon: { agents: 'AGENTS.md', skills: 'skills' },
    targets: ['claude'],
    mcpServers: {},
  };
  fs.writeFileSync(path.join(from, 'agents.json'), JSON.stringify(cfg, null, 2));

  // skills directory with one valid skill
  const skillDir = path.join(from, 'skills', 'my-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: my-skill\ndescription: A test skill\n---\nBody.');

  // Sync generated files into out
  const canon = { agentsMd: '# Contract\nSome content.', config: cfg };
  const skills = [{ name: 'my-skill', description: 'A test skill' }];
  syncTargets(canon, skills, out);

  return { from, out };
}

// (a) clean synced fixture → ok:true, no error issues
test('doctor returns ok:true for a clean synced fixture', () => {
  const { from, out } = makeFixture();
  const result = doctor(from, out);
  const errors = result.issues.filter(i => i.level === 'error');
  assert.strictEqual(errors.length, 0, `Unexpected errors: ${JSON.stringify(errors)}`);
  assert.strictEqual(result.ok, true);
});

// (b) after hand-editing a generated file → drift error + ok:false
test('doctor reports drift error after hand-editing generated file', () => {
  const { from, out } = makeFixture();
  // Hand-edit the generated file to introduce drift
  fs.writeFileSync(path.join(out, 'CLAUDE.md'), 'hand-edited content');
  const result = doctor(from, out);
  const errors = result.issues.filter(i => i.level === 'error');
  assert.ok(errors.length >= 1, 'Expected at least one error for drifted file');
  const driftMsg = errors.find(i => i.msg.includes('drift') || i.msg.includes('CLAUDE.md'));
  assert.ok(driftMsg, `Expected a drift error mentioning CLAUDE.md; got: ${JSON.stringify(errors)}`);
  assert.strictEqual(result.ok, false);
});

// (b-missing) missing generated file → error + ok:false
test('doctor reports missing error when generated file is absent', () => {
  const { from, out } = makeFixture();
  fs.rmSync(path.join(out, 'CLAUDE.md'));
  const result = doctor(from, out);
  const errors = result.issues.filter(i => i.level === 'error');
  assert.ok(errors.length >= 1, 'Expected at least one error for missing file');
  const missingMsg = errors.find(i => i.msg.includes('missing') || i.msg.includes('CLAUDE.md'));
  assert.ok(missingMsg, `Expected a missing error; got: ${JSON.stringify(errors)}`);
  assert.strictEqual(result.ok, false);
});

// (c) --fix path: syncTargets restores drift, then doctor → ok:true
test('doctor returns ok:true after syncTargets repairs drift', () => {
  const { from, out } = makeFixture();
  // Introduce drift
  fs.writeFileSync(path.join(out, 'CLAUDE.md'), 'hand-edited content');
  // Simulate --fix by re-running syncTargets
  const cfg = JSON.parse(fs.readFileSync(path.join(from, 'agents.json'), 'utf8'));
  const canon = {
    agentsMd: fs.readFileSync(path.join(from, 'AGENTS.md'), 'utf8'),
    config: cfg,
  };
  syncTargets(canon, [], out);
  // Now doctor should be clean
  const result = doctor(from, out);
  const errors = result.issues.filter(i => i.level === 'error');
  assert.strictEqual(errors.length, 0, `Expected no errors after fix; got: ${JSON.stringify(errors)}`);
  assert.strictEqual(result.ok, true);
});

// unknown target in config → warn (not error), ok still true
test('doctor emits warn for unknown target', () => {
  const { from, out } = makeFixture();
  // Overwrite agents.json with an unknown target
  const cfg = {
    version: '1.0',
    canon: { agents: 'AGENTS.md', skills: 'skills' },
    targets: ['claude', 'unknown-target-xyz'],
    mcpServers: {},
  };
  fs.writeFileSync(path.join(from, 'agents.json'), JSON.stringify(cfg, null, 2));
  const result = doctor(from, out);
  const warns = result.issues.filter(i => i.level === 'warn');
  const targetWarn = warns.find(i => i.msg.includes('unknown-target-xyz'));
  assert.ok(targetWarn, `Expected warn for unknown target; got warns: ${JSON.stringify(warns)}`);
  // Should still be ok (warn doesn't affect ok)
  const errors = result.issues.filter(i => i.level === 'error');
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(result.ok, true);
});

// agents.local.json present → info message
test('doctor emits info when agents.local.json exists', () => {
  const { from, out } = makeFixture();
  fs.writeFileSync(path.join(from, 'agents.local.json'), '{}');
  const result = doctor(from, out);
  const infos = result.issues.filter(i => i.level === 'info');
  const localInfo = infos.find(i => i.msg.includes('agents.local.json'));
  assert.ok(localInfo, `Expected info about agents.local.json; got: ${JSON.stringify(infos)}`);
});
