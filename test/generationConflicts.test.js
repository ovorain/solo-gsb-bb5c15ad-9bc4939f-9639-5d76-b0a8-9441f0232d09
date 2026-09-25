'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  generationDistancesUp,
  findGenerationConflicts,
} = require('../server/familyGraph');

/** 测试辅助：批量建成员（直接用姓名当 ID） */
function makeState(names) {
  const state = createState();
  for (const name of names) {
    state.members.push({ id: name, name });
    state.parentsOf[name] = [];
  }
  return state;
}

function add(state, parent, child) {
  const r = validateEdge(state, parent, child);
  assert.equal(r.error, null, `应允许 ${parent} -> ${child}`);
  state.parentsOf[child].push(parent);
}

test('代数距离：单链上最少=最多，且给出完整成员链', () => {
  // A -> B -> C -> D（父母 → 子女）
  const state = makeState(['A', 'B', 'C', 'D']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  add(state, 'C', 'D');

  const d = generationDistancesUp(state, 'D');
  assert.equal(d.get('D').minGen, 0);
  assert.equal(d.get('D').maxGen, 0);
  assert.deepEqual(d.get('A'), {
    minGen: 3,
    maxGen: 3,
    shortestPath: ['D', 'C', 'B', 'A'],
    longestPath: ['D', 'C', 'B', 'A'],
  });
  assert.ok(!d.has('X'), '无祖先关系的成员不应出现');
});

test('代数距离：同代不同路径（父系母系同代）不产生差异', () => {
  // G 的两个孩子 P1、P2；X 的父母是 P1、P2 —— X 到 G 两条路径均为 2 代
  const state = makeState(['G', 'P1', 'P2', 'X']);
  add(state, 'G', 'P1');
  add(state, 'G', 'P2');
  add(state, 'P1', 'X');
  add(state, 'P2', 'X');

  const d = generationDistancesUp(state, 'X');
  assert.equal(d.get('G').minGen, 2);
  assert.equal(d.get('G').maxGen, 2);
  assert.equal(d.get('G').shortestPath.length, 3);
  assert.equal(d.get('G').longestPath.length, 3);
});

test('代数距离：同一对祖先-后代存在 1 代直达与 3 代绕行两条路径', () => {
  // 边（父母 → 子女）：A→B 直达；另有 A→X→Y→B。
  // B 的父母为 A、Y；Y 的父母为 X；X 的父母为 A。图仍为 DAG。
  const state = makeState(['A', 'X', 'Y', 'B']);
  add(state, 'A', 'X');
  add(state, 'X', 'Y');
  add(state, 'Y', 'B');
  add(state, 'A', 'B');

  const d = generationDistancesUp(state, 'B');
  assert.equal(d.get('A').minGen, 1);
  assert.equal(d.get('A').maxGen, 3);
  assert.deepEqual(d.get('A').shortestPath, ['B', 'A']);
  assert.deepEqual(d.get('A').longestPath, ['B', 'Y', 'X', 'A']);
  // 其余祖先只有唯一路径长度
  assert.equal(d.get('Y').maxGen, 1);
  assert.equal(d.get('X').maxGen, 2);
});

test('矛盾核查：无矛盾家谱返回空（同代多路径不报警）', () => {
  // GP1/GP2 -> P1/P2 -> X：X 到 GP 恒为 2 代
  const state = makeState(['GP1', 'GP2', 'P1', 'P2', 'X']);
  add(state, 'GP1', 'P1');
  add(state, 'GP2', 'P1');
  add(state, 'GP1', 'P2');
  add(state, 'GP2', 'P2');
  add(state, 'P1', 'X');
  add(state, 'P2', 'X');

  const r = findGenerationConflicts(state);
  assert.equal(r.error, undefined);
  assert.equal(r.conflictCount, 0);
  assert.deepEqual(r.conflicts, []);
  assert.ok(r.ancestorPairCount > 0, '仍应统计存在祖先关系的成员对');
});

test('矛盾核查：列出全部 min≠max 的祖先对，链方向为后代→祖先', () => {
  // A→B、A→C 各有一条直达 1 代路径，同时各有一条 3 代绕行路径：
  //   A→X→Y→B，A→X→Z→C（共用中间代 X）
  const state = makeState(['A', 'X', 'Y', 'Z', 'B', 'C']);
  add(state, 'A', 'X');
  add(state, 'X', 'Y');
  add(state, 'Y', 'B');
  add(state, 'A', 'B');
  add(state, 'X', 'Z');
  add(state, 'Z', 'C');
  add(state, 'A', 'C');

  const r = findGenerationConflicts(state);
  const keys = r.conflicts.map((c) => `${c.ancestorId}>${c.descendantId}`).sort();
  assert.deepEqual(keys, ['A>B', 'A>C']);

  for (const c of r.conflicts) {
    assert.equal(c.minGen, 1);
    assert.equal(c.maxGen, 3);
    assert.equal(c.generationGap, 2);
    assert.deepEqual(c.shortestPath[0], c.descendantId);
    assert.equal(c.shortestPath[c.shortestPath.length - 1], c.ancestorId);
    assert.deepEqual(c.longestPath[0], c.descendantId);
    assert.equal(c.longestPath[c.longestPath.length - 1], c.ancestorId);
  }
  assert.deepEqual(r.conflicts.find((c) => c.descendantId === 'B').longestPath, ['B', 'Y', 'X', 'A']);
  assert.deepEqual(r.conflicts.find((c) => c.descendantId === 'C').longestPath, ['C', 'Z', 'X', 'A']);

  // 唯一长度的祖先对（如 X→B 恒 2 代）不报警
  assert.ok(!r.conflicts.some((c) => c.ancestorId === 'X'));
});

test('矛盾核查：按成员筛选只保留其作为祖先或后代的矛盾', () => {
  const state = makeState(['A', 'X', 'Y', 'Z', 'B', 'C']);
  add(state, 'A', 'X');
  add(state, 'X', 'Y');
  add(state, 'Y', 'B');
  add(state, 'A', 'B');
  add(state, 'X', 'Z');
  add(state, 'Z', 'C');
  add(state, 'A', 'C');

  const byB = findGenerationConflicts(state, 'B');
  assert.deepEqual(
    byB.conflicts.map((c) => `${c.ancestorId}>${c.descendantId}`),
    ['A>B'],
  );

  const byA = findGenerationConflicts(state, 'A');
  assert.equal(byA.conflictCount, 2);
  assert.ok(byA.conflicts.every((c) => c.ancestorId === 'A'));

  // X 出现在多条祖先链上但相关对均无矛盾：0 条
  const byX = findGenerationConflicts(state, 'X');
  assert.equal(byX.conflictCount, 0);
  // ancestorPairCount 是全图统计，不受筛选影响
  const all = findGenerationConflicts(state);
  assert.equal(byX.ancestorPairCount, all.ancestorPairCount);
});

test('矛盾核查：筛选成员不存在时返回错误', () => {
  const state = makeState(['A']);
  const r = findGenerationConflicts(state, 'NOPE');
  assert.match(r.error, /成员不存在/);
});

test('矛盾核查：空图与完全无关系时均无矛盾', () => {
  assert.equal(findGenerationConflicts(createState()).conflictCount, 0);

  const state = makeState(['A', 'B']); // 两人但无边
  const r = findGenerationConflicts(state);
  assert.equal(r.ancestorPairCount, 0);
  assert.equal(r.conflictCount, 0);
});
