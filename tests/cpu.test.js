'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/game.js');
const Cpu = require('../js/cpu.js');

const zero = () => 0;

/* 任意配置の局面とスタブセッション（CPU = B）を作る */
function makeSession(positions, bTypes, capturedBy) {
  const placements = {};
  for (const [id, pos] of Object.entries(positions)) placements[id] = pos;
  // 配置していない駒は盤外相当のダミー位置に置かず、必ず全駒を渡す前提にする
  const state = G.createGame(placements, 'B');
  if (capturedBy) state.capturedBy = capturedBy;
  return {
    state,
    me: 'B',
    phase: 'playing',
    moves: [],
    ownTypes: () => bTypes,
    doMove(m) { this.moves.push(m); return true; },
  };
}

/* A は自陣（下段）、B は自陣（上段）に並べた標準配置 */
function basePositions() {
  const pos = {};
  G.placementCells('A').forEach((c, i) => { pos['A' + i] = c; });
  G.placementCells('B').forEach((c, i) => { pos['B' + i] = c; });
  return pos;
}
const typesOf = (list) => Object.fromEntries(list.map((t, i) => ['B' + i, t]));
const MIXED = ['angel', 'demon', 'angel', 'demon', 'angel', 'demon', 'angel', 'demon'];

test('CPU: 脱出マス上の自分の天使は必ず脱出する（全レベル）', () => {
  for (const level of [1, 2, 3]) {
    const pos = basePositions();
    pos.B0 = { x: 0, y: 5 }; // B の脱出マス
    const s = makeSession(pos, typesOf(MIXED));
    assert.strictEqual(Cpu.takeTurn(s, zero, level), true);
    assert.deepStrictEqual(s.moves[0], { kind: 'exit', pieceId: 'B0' }, `level ${level}`);
  }
});

test('CPU（ふつう/つよい）: 相手の脱出は、悪魔を3体取っていても止める', () => {
  for (const level of [2, 3]) {
    const pos = basePositions();
    pos.A0 = { x: 0, y: 0 }; // A の脱出マスに A の駒
    pos.B0 = { x: 1, y: 0 }; // 隣から捕獲できる
    const capturedBy = { A: { angel: 0, demon: 0 }, B: { angel: 0, demon: 3 } };
    const s = makeSession(pos, typesOf(MIXED), capturedBy);
    assert.strictEqual(Cpu.takeTurn(s, zero, level), true);
    assert.deepStrictEqual(s.moves[0].to, { x: 0, y: 0 }, `level ${level} で脱出阻止の捕獲を選ぶ`);
  }
});

test('CPU（ふつう/つよい）: 悪魔を3体取っていたら通常の捕獲はしない', () => {
  for (const level of [2, 3]) {
    const pos = basePositions();
    pos.A0 = { x: 3, y: 3 };
    pos.B0 = { x: 3, y: 2 }; // B0（悪魔）が A0 を取れる位置
    const types = typesOf(['demon', 'angel', 'angel', 'demon', 'angel', 'demon', 'angel', 'demon']);
    const capturedBy = { A: { angel: 0, demon: 0 }, B: { angel: 0, demon: 3 } };
    const s = makeSession(pos, types, capturedBy);
    assert.strictEqual(Cpu.takeTurn(s, zero, level), true);
    const m = s.moves[0];
    assert.ok(!(m.kind === 'move' && m.to && m.to.x === 3 && m.to.y === 3),
      `level ${level} で (3,3) の捕獲を選ばない`);
  }
});

test('CPU（つよい）: 選んだ手が常に合法手である', () => {
  const pos = basePositions();
  pos.A0 = { x: 2, y: 3 };
  pos.B3 = { x: 2, y: 2 };
  pos.B0 = { x: 1, y: 4 };
  const s = makeSession(pos, typesOf(MIXED));
  assert.strictEqual(Cpu.takeTurn(s, () => 0.42, 3), true);
  const m = s.moves[0];
  if (m.kind === 'exit') {
    assert.ok(G.isOnTargetExit('B', pos[m.pieceId].x, pos[m.pieceId].y));
  } else {
    const legal = G.legalDestinations(s.state, m.pieceId);
    assert.ok(legal.some((d) => d.x === m.to.x && d.y === m.to.y), '合法手の中から選ばれている');
  }
});

test('CPU: 配置は全レベルで天使4・悪魔4', () => {
  for (const level of [1, 2, 3]) {
    const t = Cpu.randomTypes(() => 0.3, level);
    assert.strictEqual(t.length, 8);
    assert.strictEqual(t.filter((x) => x === 'angel').length, 4);
    assert.strictEqual(t.filter((x) => x === 'demon').length, 4);
  }
});
