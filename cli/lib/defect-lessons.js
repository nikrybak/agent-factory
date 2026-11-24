// cli/lib/defect-lessons.js
// ADR-0030: a defect closes with a lesson. Scans the tracked defect ledgers of the child projects
// (app_entry_root/<key>/_project/**/*DEFECTS*.md) and refuses a closed defect without a lesson that
// lives in a skill. Child version directories (<key>-v1/) are separate repositories and are not scanned.
const fs = require('node:fs');
const path = require('node:path');

const FRAME_LESSONS = path.join('skills', 'nrg-game-ui', 'references', 'frame-lessons.md');
const MIN_REASON = 10;

// State prefix (lower case) -> class. Longer prefixes are listed so "owner review" is not mistaken for another state.
const STATE_CLASSES = [
  ['fixed', 'closed'], ['done', 'closed'],
  ['open', 'open'], ['partly', 'open'], ['owner review', 'open'],
  ['accepted', 'note'], ['tool note', 'note'], ['plan note', 'note'], ['warning', 'note'], ['moved', 'note'],
];

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i += 1; } else if (text[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += text[i];
  }
  cells.push(cell.trim());
  return cells;
}

const isSeparator = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u.test(line);

/** Markdown tables of a text: [{ header: string[], rows: [{ cells, line }] }]. */
function parseTables(text) {
  const lines = text.split(/\r?\n/u);
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|') || !lines[i + 1] || !isSeparator(lines[i + 1])) continue;
    const table = { header: splitRow(lines[i]), rows: [] };
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
      table.rows.push({ cells: splitRow(lines[j]), line: j + 1 });
    }
    tables.push(table);
    i = j - 1;
  }
  return tables;
}

/** Ids `GU<n>` that exist as a table row `| GU<n> |` in the nrg-game-ui frame lessons. */
function readLessonIds(baseRoot) {
  const file = path.join(baseRoot, FRAME_LESSONS);
  if (!fs.existsSync(file)) return new Set();
  const ids = new Set();
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/^\|\s*(GU\d+)\s*\|/gmu)) ids.add(match[1]);
  return ids;
}

/** Defect ledger files: app_entry_root/<key>/_project/**\/*DEFECTS*.md. */
function findLedgerFiles(baseRoot) {
  const entryRoot = path.join(baseRoot, 'app_entry_root');
  const found = [];
  if (!fs.existsSync(entryRoot)) return found;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/DEFECTS.*\.md$/iu.test(entry.name)) found.push(full);
    }
  };
  for (const child of fs.readdirSync(entryRoot, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name.startsWith('_') || child.name.startsWith('.')) continue;
    const project = path.join(entryRoot, child.name, '_project');
    if (fs.existsSync(project)) walk(project);
  }
  return found.sort();
}

/**
 * Judge one Lesson cell. Returns { refs, evidence, pending, none, lintOnly, problems } where problems lists bad references.
 */
function judgeLesson(cell, ctx) {
  const text = cell.replace(/`/gu, '');
  const problems = [];
  let evidence = 0;
  for (const match of text.matchAll(/\bGU\d+\b/gu)) {
    if (ctx.lessonIds.has(match[0])) evidence += 1;
    else problems.push(`unknown lesson ${match[0]} (no row in ${FRAME_LESSONS.replace(/\\/gu, '/')})`);
  }
  for (const match of text.matchAll(/\bskill:([A-Za-z0-9_.-]+)(?:\/([^\s,;)]+))?/gu)) {
    const [, name, rel] = match;
    const skillMd = path.join(ctx.baseRoot, 'skills', name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) { problems.push(`unknown skill ${name} (skills/${name}/SKILL.md missing)`); continue; }
    if (rel && !fs.existsSync(path.join(ctx.baseRoot, 'skills', name, rel))) {
      problems.push(`unknown skill file ${name}/${rel}`);
      continue;
    }
    evidence += 1;
  }
  const lint = /\blint:[A-Za-z0-9_.-]+/u.test(text);
  const none = /\bnone:\s*(.*)$/u.exec(text);
  return {
    evidence, problems, lint,
    pending: /(^|[\s,;])pending\b/iu.test(text),
    none: none ? none[1].trim() : null,
  };
}

function checkRow(row, cols, ctx, relFile) {
  const id = row.cells[cols.id];
  const state = (row.cells[cols.state] || '').trim();
  const lessonCell = (row.cells[cols.lesson] || '').trim();
  const issues = [];
  const bad = problem => issues.push({ file: relFile, id, line: row.line, problem });
  const stateKey = state.toLowerCase();
  const cls = (STATE_CLASSES.find(([prefix]) => stateKey.startsWith(prefix)) || [])[1];
  if (!cls) { bad(`unknown state "${state}"`); return issues; }
  if (!lessonCell) { bad(`empty Lesson cell for state "${state}"`); return issues; }
  const lesson = judgeLesson(lessonCell, ctx);
  for (const problem of lesson.problems) bad(problem);
  if (lesson.problems.length) return issues;
  if (lesson.evidence > 0) return issues;
  if (cls === 'closed') {
    bad(lesson.lint
      ? 'FIXED/DONE needs a lesson in a skill (GU<n> or skill:<name>); lint:<rule> alone is not enough'
      : 'FIXED/DONE needs a lesson in a skill (GU<n> or skill:<name>)');
  } else if (cls === 'open') {
    if (!lesson.pending) bad('OPEN/partly/OWNER REVIEW needs a lesson (GU<n>, skill:<name>) or "pending"');
  } else if (lesson.none === null || lesson.none.length < MIN_REASON) {
    bad(`state "${state}" needs a lesson or "none: <reason>" with a reason of at least ${MIN_REASON} characters`);
  }
  return issues;
}

/** Scan the ledgers of a base repository. Returns [{ file, id, line, problem }]. */
function scanDefectLedgers(baseRoot) {
  const ctx = { baseRoot, lessonIds: readLessonIds(baseRoot) };
  const issues = [];
  for (const file of findLedgerFiles(baseRoot)) {
    const relFile = path.relative(baseRoot, file).replace(/\\/gu, '/');
    for (const table of parseTables(fs.readFileSync(file, 'utf8'))) {
      const names = table.header.map(name => name.toLowerCase());
      const id = names.indexOf('id');
      const state = names.indexOf('state');
      if (id < 0 || state < 0) continue;
      const lesson = names.indexOf('lesson');
      if (lesson < 0) {
        issues.push({ file: relFile, id: '(table)', line: 0, problem: 'defect ledger has no Lesson column' });
        continue;
      }
      for (const row of table.rows) {
        if (!row.cells[id]) continue;
        issues.push(...checkRow(row, { id, state, lesson }, ctx, relFile));
      }
    }
  }
  return issues;
}

module.exports = { scanDefectLedgers, parseTables, findLedgerFiles, readLessonIds };
