'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const G = require('../js/game.js');

function placementsFor(player, typesInCellOrder) {
  // 配置UIと同じ順序（placementCells の順）で A0..A7 を割り当てる
  const cells = G.placementCells(player);
  const placements = {};
  cells.forEach((c, i) => { placements[G.pieceId(player, i)] = c; });
  return placements;
}
function freshGame(firstPlayer = 'A') {
  return G.createGame(
    { ...placementsFor('A'), ...placementsFor('B') },
    firstPlayer
  );
}

test('配置マスは各陣地8マス・中央4列', () => {
  assert.strictEqual(G.placementCells('A').length, 8);
  assert.strictEqual(G.placementCells('B').length, 8);
  assert.ok(G.isPlacementCell('A', 1, 4) && G.isPlacementCell('A', 4, 5));
  assert.ok(!G.isPlacementCell('A', 0, 4) && !G.isPlacementCell('A', 1, 3));
  assert.ok(G.isPlacementCell('B', 4, 0) && !G.isPlacementCell('B', 4, 5));
});

test('脱出マスは相手陣地の左右の角', () => {
  assert.deepStrictEqual(G.targetExits('A'), [{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  assert.deepStrictEqual(G.targetExits('B'), [{ x: 0, y: 5 }, { x: 5, y: 5 }]);
});

test('種類の内訳バリデーション（天使4・悪魔4）', () => {
  assert.strictEqual(G.validateTypes(['angel', 'angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'demon']), null);
  assert.ok(G.validateTypes(['angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'demon', 'demon']));
  assert.ok(G.validateTypes(['angel']));
});

test('配置バリデーション（重複・陣地外を検出）', () => {
  const ok = placementsFor('A');
  assert.strictEqual(G.validatePlacements('A', ok), null);
  const dup = placementsFor('A');
  dup.A1 = { ...dup.A0 };
  assert.ok(G.validatePlacements('A', dup));
  const out = placementsFor('A');
  out.A0 = { x: 0, y: 0 };
  assert.ok(G.validatePlacements('A', out));
});

test('移動は上下左右1マスのみ・自駒のマスには行けない', () => {
  const s = freshGame();
  // A0 は (1,4)。右(2,4=A1)と下(1,5=A4)は自駒で不可。左(0,4)と上(1,3)は空き
  const dests = G.legalDestinations(s, 'A0').map((d) => `${d.x},${d.y}`);
  assert.deepStrictEqual(dests, ['0,4', '1,3']);
  // 斜め移動は不正
  const bad = G.validateMove(s, 'A', { kind: 'move', pieceId: 'A0', to: { x: 2, y: 3 } });
  assert.strictEqual(bad.ok, false);
  // 相手の手番に動かすのは不正
  const wrongTurn = G.validateMove(s, 'B', { kind: 'move', pieceId: 'B0', to: { x: 1, y: 2 } });
  assert.strictEqual(wrongTurn.ok, false);
  // 相手の駒を動かすのは不正
  const notMine = G.validateMove(s, 'A', { kind: 'move', pieceId: 'B0', to: { x: 1, y: 2 } });
  assert.strictEqual(notMine.ok, false);
});

test('捕獲で相手の駒が除去される', () => {
  const s = freshGame();
  // A0(1,4) を前進させ、B陣2段目の B4(1,1) を捕獲する想定の簡易シナリオ
  const a0 = G.getPiece(s, 'A0');
  a0.x = 1; a0.y = 2; // テスト用に直接配置（公開状態の操作）
  const res = G.validateMove(s, 'A', { kind: 'move', pieceId: 'A0', to: { x: 1, y: 1 } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.captured.id, 'B4');
  const { captured } = G.applyMove(s, { kind: 'move', pieceId: 'A0', to: { x: 1, y: 1 } });
  assert.strictEqual(captured.alive, false);
});

test('勝利条件: 相手の天使4体捕獲で勝利、悪魔4体捕獲で敗北', () => {
  const s1 = freshGame();
  for (let i = 0; i < 4; i++) G.recordCapture(s1, 'A', 'angel');
  assert.strictEqual(s1.winner, 'A');
  assert.strictEqual(s1.winReason, 'capture-angels');

  const s2 = freshGame();
  for (let i = 0; i < 4; i++) G.recordCapture(s2, 'A', 'demon');
  assert.strictEqual(s2.winner, 'B');
  assert.strictEqual(s2.winReason, 'capture-demons');
});

test('脱出は脱出マス上でのみ可能で、勝利になる', () => {
  const s = freshGame();
  const bad = G.validateMove(s, 'A', { kind: 'exit', pieceId: 'A0' });
  assert.strictEqual(bad.ok, false);
  const a0 = G.getPiece(s, 'A0');
  a0.x = 0; a0.y = 0; // Aの脱出マスへ
  const ok = G.validateMove(s, 'A', { kind: 'exit', pieceId: 'A0' });
  assert.strictEqual(ok.ok, true);
  G.applyMove(s, { kind: 'exit', pieceId: 'A0' });
  G.recordExit(s, 'A');
  assert.strictEqual(s.winner, 'A');
  assert.strictEqual(s.winReason, 'exit');
});

test('手番は交互に交代し、勝敗確定後は交代しない', () => {
  const s = freshGame();
  assert.strictEqual(s.turn, 'A');
  G.endTurn(s);
  assert.strictEqual(s.turn, 'B');
  s.winner = 'A';
  G.endTurn(s);
  assert.strictEqual(s.turn, 'B');
});

test('コミットメント: 同じ入力からは同じハッシュ、種類を変えると一致しない', () => {
  const h = (id, type, nonce) =>
    crypto.createHash('sha256').update(G.commitmentInput(id, type, nonce)).digest('hex');
  const nonce = '0123456789abcdef0123456789abcdef';
  assert.strictEqual(h('A0', 'angel', nonce), h('A0', 'angel', nonce));
  assert.notStrictEqual(h('A0', 'angel', nonce), h('A0', 'demon', nonce));
  assert.match(h('A0', 'angel', nonce), /^[0-9a-f]{64}$/);
});

test('脱出の検証: 脱出マスの上でのみ脱出でき、盤外や通常マスではできない', () => {
  const s = freshGame('A');
  // A0 は (1,4) で脱出マスではない
  assert.strictEqual(G.validateMove(s, 'A', { kind: 'exit', pieceId: 'A0' }).ok, false);
  // 駒を脱出マス (0,0) まで運んだ状態を作る（直接配置換えではなく applyMove で進める代わりに座標を差し替える）
  const p = G.getPiece(s, 'A0');
  p.x = 0; p.y = 0;
  assert.strictEqual(G.validateMove(s, 'A', { kind: 'exit', pieceId: 'A0' }).ok, true);
  const res = G.applyMove(s, { kind: 'exit', pieceId: 'A0' });
  assert.strictEqual(res.piece.alive, false);
  G.recordExit(s, 'A');
  assert.strictEqual(s.winner, 'A');
  assert.strictEqual(s.winReason, 'exit');
});

test('悪魔を4体捕獲した側が負ける', () => {
  const s = freshGame('A');
  for (let i = 0; i < 4; i++) G.recordCapture(s, 'A', 'demon');
  assert.strictEqual(s.winner, 'B');
  assert.strictEqual(s.winReason, 'capture-demons');
});

test('天使を4体捕獲した側が勝つ', () => {
  const s = freshGame('B');
  for (let i = 0; i < 4; i++) G.recordCapture(s, 'B', 'angel');
  assert.strictEqual(s.winner, 'B');
  assert.strictEqual(s.winReason, 'capture-angels');
});

test('配置検証: 重なりと陣地外を弾く', () => {
  const ok = placementsFor('A');
  assert.strictEqual(G.validatePlacements('A', ok), null);
  const dup = { ...ok, A1: { ...ok.A0 } };
  assert.ok(G.validatePlacements('A', dup) !== null);
  const out = { ...ok, A0: { x: 0, y: 0 } };
  assert.ok(G.validatePlacements('A', out) !== null);
});

test('捕獲の適用: 取った駒は無効化され、移動側がそのマスに入る', () => {
  const s = freshGame('A');
  const a0 = G.getPiece(s, 'A0'); a0.x = 1; a0.y = 2;
  const b4 = G.getPiece(s, 'B4'); b4.x = 1; b4.y = 1;
  const { captured } = G.applyMove(s, { kind: 'move', pieceId: 'A0', to: { x: 1, y: 1 } });
  assert.strictEqual(captured.id, 'B4');
  assert.strictEqual(b4.alive, false);
  assert.strictEqual(G.pieceAt(s, 1, 1).id, 'A0');
});

test('summarizeFor: 自分視点の勝敗進捗（公開情報のみ）を返す', () => {
  const s = freshGame('A');
  s.capturedBy.A.angel = 3;
  s.capturedBy.A.demon = 1;
  s.capturedBy.B.angel = 2;
  s.capturedBy.B.demon = 4;
  const forA = G.summarizeFor(s, 'A');
  const byKey = Object.fromEntries(forA.map((i) => [i.key, i]));
  assert.strictEqual(byKey['take-angel'].count, 3);
  assert.strictEqual(byKey['take-angel'].effect, 'win');
  assert.strictEqual(byKey['take-demon'].count, 1);
  assert.strictEqual(byKey['take-demon'].effect, 'lose');
  assert.strictEqual(byKey['lost-angel'].count, 2);
  assert.strictEqual(byKey['lost-angel'].effect, 'lose');
  assert.strictEqual(byKey['lost-demon'].count, 4);
  assert.strictEqual(byKey['lost-demon'].effect, 'win');
  // 相手視点では攻守が入れ替わる
  const forB = Object.fromEntries(G.summarizeFor(s, 'B').map((i) => [i.key, i]));
  assert.strictEqual(forB['take-angel'].count, 2);
  assert.strictEqual(forB['lost-demon'].count, 1);
});
