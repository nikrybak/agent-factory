'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { coverageTable, coverageTotals, mergeLcov, uncoveredRanges } = require('../lib/lcov');

const RUN_A = [
  'TN:', 'SF:cli\\lib\\a.js',
  'FN:1,first', 'FN:5,second', 'FNDA:2,first', 'FNDA:0,second', 'FNF:2', 'FNH:1',
  'DA:1,2', 'DA:2,2', 'DA:5,0', 'DA:6,0',
  'BRDA:1,0,0,2', 'BRDA:2,1,0,0', 'BRDA:2,2,0,2', 'BRF:3', 'BRH:2',
  'end_of_record',
].join('\r\n');
// the same file seen by another test: other block numbers for the same branches, the second function called
const RUN_B = [
  'TN:', 'SF:cli/lib/a.js',
  'FN:1,first', 'FN:5,second', 'FNDA:0,first', 'FNDA:3,second',
  'DA:1,0', 'DA:2,0', 'DA:5,3', 'DA:6,0',
  'BRDA:1,7,0,0', 'BRDA:2,8,0,4', 'BRDA:2,9,0,-',
  'end_of_record',
  'SF:cli/lib/b.js', 'FN:1,only', 'FNDA:1,only', 'DA:1,1', 'end_of_record',
].join('\n');

test('a line, function or branch is covered when any run covered it; paths and block numbers do not split records', () => {
  const files = mergeLcov([RUN_A, RUN_B]);
  assert.deepEqual([...files.keys()], ['cli/lib/a.js', 'cli/lib/b.js']);
  const a = files.get('cli/lib/a.js');
  assert.deepEqual([...a.lines], [[1, 2], [2, 2], [5, 3], [6, 0]]);
  assert.deepEqual([...a.functions], [['1#0', 2], ['5#0', 3]]);
  assert.deepEqual([...a.branches], [['1#0', 2], ['2#0', 4], ['2#1', 2]]);
});

test('totals are summed over every file, as Node reports one run', () => {
  const totals = coverageTotals(mergeLcov([RUN_A, RUN_B]));
  assert.equal(totals.lines, 80); // 4 of 5 lines
  assert.equal(totals.functions, 100);
  assert.equal(totals.branches, 100);
  assert.deepEqual(coverageTotals(mergeLcov([RUN_A])), { lines: 50, branches: (2 / 3) * 100, functions: 50 });
  assert.deepEqual(coverageTotals(new Map()), { lines: 100, branches: 100, functions: 100 });
});

test('the table keeps the "all files" row the gate parses and lists uncovered lines as ranges', () => {
  const table = coverageTable(mergeLcov([RUN_A]));
  assert.match(table, /all files\s*\|\s*50\.00\s*\|\s*66\.67\s*\|\s*50\.00\s*\|/);
  assert.match(table, /cli\/lib\/a\.js\s*\|\s*50\.00 \|\s*66\.67 \|\s*50\.00 \| 5-6/);
  assert.equal(uncoveredRanges(new Map([[3, 0], [4, 0], [5, 0], [9, 0], [10, 1]])), '3-5 9');
});

test('text before the first source file and a record without its end are read safely', () => {
  const files = mergeLcov(['DA:1,1\nSF:x.js\nFN:1,f\nFNDA:1,f\nDA:1,1']);
  assert.deepEqual([...files.get('x.js').functions], [['1#0', 1]]);
  assert.equal(files.size, 1);
});
