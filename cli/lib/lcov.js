'use strict';

/**
 * LCOV records of several coverage runs merged into one coverage table (ADR-0021, amendment 2026-10-30).
 *
 * The gate measures every test file in a process of its own and keeps each file's LCOV with the inputs it read, so
 * after an edit only the affected files are measured again. A line, function or branch counts as covered when any run
 * covered it; the totals are summed over all source files, as Node's own report does for one run. Records are matched by
 * line and place on the line (Node numbers blocks and anonymous functions with one counter per file); V8 reports a
 * block only where its count differs from the enclosing range, so runs see different block sets and the merged branch
 * share differs from one combined run; it read lower (88.41 against 89.62 % on 2026-10-30).
 */

function emptyFile() {
  return { lines: new Map(), functions: new Map(), branches: new Map() };
}

function mark(map, key, hits) {
  map.set(key, (map.get(key) || 0) + hits);
}

/** Merge LCOV texts into `{ path -> { lines, functions, branches } }`, each a map of key to hit count. */
function mergeLcov(texts) {
  const files = new Map();
  for (const text of texts) {
    let current = null;
    let seen = new Map();
    let names = [];
    let hits = [];
    const closeFunctions = () => {
      // FN and FNDA come in the same order. A function is its line and its place among the functions of that line:
      // the names of anonymous functions are numbered by one counter over the file, like the branch blocks
      const places = new Map();
      names.forEach((fn, index) => {
        const place = places.get(fn.line) || 0;
        places.set(fn.line, place + 1);
        mark(current.functions, `${fn.line}#${place}`, hits[index] || 0);
      });
      names = [];
      hits = [];
    };
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('SF:')) {
        const name = line.slice(3).replace(/\\/g, '/');
        if (!files.has(name)) files.set(name, emptyFile());
        current = files.get(name);
        seen = new Map();
      } else if (!current) {
        continue;
      } else if (line.startsWith('FN:')) {
        const [at, ...rest] = line.slice(3).split(',');
        names.push({ line: Number(at), name: rest.join(',') });
      } else if (line.startsWith('FNDA:')) {
        hits.push(Number(line.slice(5).split(',')[0]) || 0);
      } else if (line.startsWith('DA:')) {
        const [at, count] = line.slice(3).split(',');
        mark(current.lines, Number(at), Number(count) || 0);
      } else if (line.startsWith('BRDA:')) {
        // Node numbers the blocks with one counter over the whole file, so the same branch has another block number in
        // a run that saw other functions; its line and its place among the branches of that line stay the same
        const [at, , , taken] = line.slice(5).split(',');
        const place = seen.get(at) || 0;
        seen.set(at, place + 1);
        mark(current.branches, `${at}#${place}`, taken === '-' ? 0 : Number(taken) || 0);
      } else if (line === 'end_of_record') {
        closeFunctions();
        current = null;
      }
    }
    if (current) closeFunctions();
  }
  return files;
}

function share(map) {
  const total = map.size;
  let covered = 0;
  for (const hits of map.values()) if (hits > 0) covered += 1;
  return { covered, total };
}

function percent({ covered, total }) {
  return total === 0 ? 100 : (covered / total) * 100;
}

/** Uncovered line numbers as ranges, "3-5 9". */
function uncoveredRanges(lines) {
  const missing = [...lines].filter(([, hits]) => hits === 0).map(([at]) => at).sort((a, b) => a - b);
  const ranges = [];
  for (const at of missing) {
    const last = ranges[ranges.length - 1];
    if (last && at === last[1] + 1) last[1] = at;
    else ranges.push([at, at]);
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(' ');
}

/** Totals of a merged set: `{ lines, branches, functions }` in percent. */
function coverageTotals(files) {
  const sum = { lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } };
  for (const file of files.values()) {
    for (const kind of Object.keys(sum)) {
      const part = share(file[kind]);
      sum[kind].covered += part.covered;
      sum[kind].total += part.total;
    }
  }
  return { lines: percent(sum.lines), branches: percent(sum.branches), functions: percent(sum.functions) };
}

/** The table in the layout of Node's text report, so the gate reads its "all files" row the same way. */
function coverageTable(files) {
  const rows = [...files.keys()].sort().map(name => {
    const file = files.get(name);
    return [name, percent(share(file.lines)), percent(share(file.branches)), percent(share(file.functions)), uncoveredRanges(file.lines)];
  });
  const totals = coverageTotals(files);
  const width = Math.max(9, ...rows.map(row => row[0].length));
  const cell = value => value.toFixed(2).padStart(6);
  const line = (name, l, b, f, rest) => `# ${name.padEnd(width)} | ${cell(l)} | ${cell(b)} | ${cell(f)} | ${rest}`;
  return [
    '# coverage merged from per-file runs',
    `# ${'file'.padEnd(width)} | line % | branch % | funcs % | uncovered lines`,
    ...rows.map(row => line(...row)),
    line('all files', totals.lines, totals.branches, totals.functions, ''),
    '',
  ].join('\n');
}

module.exports = { coverageTable, coverageTotals, mergeLcov, uncoveredRanges };
