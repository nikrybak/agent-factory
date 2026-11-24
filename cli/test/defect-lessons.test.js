// cli/test/defect-lessons.test.js
// ADR-0030: a defect closes with a lesson. Fixtures are throw-away base roots under DEV_TEMP, never the real repo files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDefectLedgers } = require('../lib/defect-lessons');

const HEADER = '| Id | Plan | Defect | State | Lesson |\n|---|---|---|---|---|\n';

function mkBase(t, ledger, { file = 'R1-DEFECTS.md', extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.DEV_TEMP || os.tmpdir(), 'defect-lessons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('skills/nrg-game-ui/references/frame-lessons.md', '| GU1 | a lesson | src | FR1 |\n| GU2 | another | src | FR2 |\n');
  put('skills/nrg-game-ui/SKILL.md', '---\nname: nrg-game-ui\n---\n');
  put('skills/nrg-game-ui/references/verification.md', 'v');
  put(`app_entry_root/demo/_project/docs/${file}`, ledger);
  for (const [rel, text] of Object.entries(extra)) put(rel, text);
  return root;
}

const problems = root => scanDefectLedgers(root).map(i => `${i.id}: ${i.problem}`);

test('a ledger where every row has a real lesson passes', t => {
  const ledger = HEADER
    + '| R1-01 | a | d | FIXED abc123 | GU1, lint:edge-fade |\n'
    + '| R1-02 | a | d | done | skill:nrg-game-ui |\n'
    + '| R1-03 | a | d | FIXED | `skill:nrg-game-ui/references/verification.md` |\n'
    + '| R1-04 | a | d | OPEN (agent lane) | pending |\n'
    + '| R1-05 | a | d | partly | GU2 |\n'
    + '| R1-06 | a | d | OWNER REVIEW | pending |\n'
    + '| R1-W3 | a | d | accepted | none: a balanced menu composition |\n'
    + '| R1-T2 | a | d | tool note | GU1 |\n';
  assert.deepStrictEqual(problems(mkBase(t, ledger)), []);
});

test('FIXED without a lesson is an error naming file and row', t => {
  const issues = scanDefectLedgers(mkBase(t, `${HEADER}| R1-11 | a | d | FIXED 1d1f98d3 |  |\n`));
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].id, 'R1-11');
  assert.match(issues[0].file, /app_entry_root\/demo\/_project\/docs\/R1-DEFECTS\.md$/);
  assert.match(issues[0].problem, /empty Lesson/);
});

test('FIXED with only a lint rule is refused', t => {
  const out = problems(mkBase(t, `${HEADER}| R1-12 | a | d | FIXED | lint:edge-fade |\n`));
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /lint:<rule> alone is not enough/);
});

test('FIXED with pending or none is refused', t => {
  const out = problems(mkBase(t, `${HEADER}| R1-1 | a | d | FIXED | pending |\n| R1-2 | a | d | DONE | none: not worth a lesson |\n`));
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /needs a lesson in a skill/);
});

test('an unknown GU or skill names the bad reference', t => {
  const out = problems(mkBase(t, `${HEADER}| R1-13 | a | d | FIXED | GU99 |\n| R1-14 | a | d | OPEN | skill:nope |\n| R1-15 | a | d | FIXED | GU1, skill:nrg-game-ui/missing.md |\n`));
  assert.strictEqual(out.length, 3);
  assert.match(out[0], /R1-13: unknown lesson GU99/);
  assert.match(out[1], /R1-14: unknown skill nope/);
  assert.match(out[2], /unknown skill file nrg-game-ui\/missing\.md/);
});

test('OPEN accepts pending and a real lesson, but not an empty or foreign cell', t => {
  const out = problems(mkBase(t, `${HEADER}| A-1 | a | d | OPEN | pending |\n| A-2 | a | d | OPEN | GU2 |\n| A-3 | a | d | OPEN | later maybe |\n`));
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /^A-3: OPEN/);
});

test('accepted with a short none reason is refused, a long one passes', t => {
  const out = problems(mkBase(t, `${HEADER}| W-1 | a | d | accepted | none: ok |\n| W-2 | a | d | warning | none: only a warning on the frame |\n| W-3 | a | d | moved | n/a |\n`));
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /^W-1: .*at least 10 characters/);
  assert.match(out[1], /^W-3:/);
});

test('a ledger table without a Lesson column is an error', t => {
  const ledger = '| Id | Plan | Defect | State |\n|---|---|---|---|\n| R1-01 | a | d | FIXED |\n';
  assert.deepStrictEqual(problems(mkBase(t, ledger)), ['(table): defect ledger has no Lesson column']);
});

test('an unknown state is an error', t => {
  const out = problems(mkBase(t, `${HEADER}| R1-20 | a | d | resolved | GU1 |\n`));
  assert.deepStrictEqual(out, ['R1-20: unknown state "resolved"']);
});

test('columns are found by header name in any order; other tables and files are ignored', t => {
  const ledger = '| State | Lesson | Id |\n|---|---|---|\n| FIXED | GU1 | X-1 |\n| FIXED | | X-2 |\n\n'
    + '| Name | Value |\n|---|---|\n| a | b |\n';
  const out = problems(mkBase(t, ledger, {
    extra: {
      'app_entry_root/demo/_project/docs/NOTES.md': HEADER + '| R-1 | a | d | FIXED | |\n',
      'app_entry_root/demo/demo-v1/docs/V-DEFECTS.md': HEADER + '| R-2 | a | d | FIXED | |\n',
      'app_entry_root/_registry/_project/X-DEFECTS.md': HEADER + '| R-3 | a | d | FIXED | |\n',
    },
  }));
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /^X-2: empty Lesson/);
});

test('escaped pipes in a cell do not shift the columns', t => {
  const out = problems(mkBase(t, `${HEADER}| R1-30 | a | uses a \\| b | FIXED | GU1 |\n`));
  assert.deepStrictEqual(out, []);
});

test('a base without ledgers has no issues', t => {
  const root = mkBase(t, 'no table here\n');
  assert.deepStrictEqual(scanDefectLedgers(root), []);
});
