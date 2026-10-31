'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const G = require('../js/game.js');
const { GameSession, validateMsg } = require('../js/session.js');

const hash = async (text) =>
  crypto.createHash('sha256').update(text).digest('hex');
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/* 2つのセッションを直接つないだ対を作る。events は記録される */
function makePair(opts = {}) {
  const logs = { A: [], B: [] };
  const captures = { A: [], B: [] };
  const verifies = { A: [], B: [] };
  let a, b;
  const mkEvents = (side) => ({
    onLog: (m) => logs[side].push(m),
    onCapture: (c) => captures[side].push(c),
    onVerify: (ok) => verifies[side].push(ok),
    onRematchOffer: () => { logs[side].push('__rematchOffer__'); },
  });
  a = new GameSession({
    me: 'A', hash, randomHex, events: mkEvents('A'),
    send: (m) => { const t = opts.tamperA ? opts.tamperA(m) : m; if (t) b.onMessage(t); },
  });
  b = new GameSession({
    me: 'B', hash, randomHex, events: mkEvents('B'),
    send: (m) => { const t = opts.tamperB ? opts.tamperB(m) : m; if (t) a.onMessage(t); },
  });
  return { a, b, logs, captures, verifies };
}

const TYPES_A = ['demon', 'angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'angel'];
const TYPES_B = ['demon', 'demon', 'demon', 'demon', 'angel', 'angel', 'angel', 'angel'];

async function startGame(pair, typesA = TYPES_A, typesB = TYPES_B) {
  await pair.a.confirmSetup(typesA);
  await pair.b.confirmSetup(typesB);
  await flush();
}

test('配置交換で両側とも対戦開始し、盤面と先手が一致する', async () => {
  const pair = makePair();
  await startGame(pair);
  assert.strictEqual(pair.a.phase, 'playing');
  assert.strictEqual(pair.b.phase, 'playing');
  assert.strictEqual(pair.a.state.turn, 'A'); // 第1局はAが先手
  assert.strictEqual(pair.b.state.turn, 'A');
  assert.deepStrictEqual(
    pair.a.state.pieces.map((p) => [p.id, p.x, p.y]),
    pair.b.state.pieces.map((p) => [p.id, p.x, p.y])
  );
});

test('捕獲すると両側で種類が一致して公開され、カウントと演出イベントが一致する', async () => {
  const pair = makePair();
  await startGame(pair);
  const { a, b } = pair;
  // A0(1,4) が B4(1,1) を取りに行く。B4 の種類は TYPES_B[4]='angel'
  assert.strictEqual(a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 3 } }), true);
  await flush();
  assert.strictEqual(b.doMove({ kind: 'move', pieceId: 'B0', to: { x: 0, y: 0 } }), true);
  await flush();
  assert.strictEqual(a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 2 } }), true);
  await flush();
  assert.strictEqual(b.doMove({ kind: 'move', pieceId: 'B1', to: { x: 1, y: 0 } }), true);
  await flush();
  assert.strictEqual(a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 1 } }), true);
  await flush();
  assert.strictEqual(a.capturedInfo.B4, 'angel');
  assert.strictEqual(b.capturedInfo.B4, 'angel');
  assert.strictEqual(a.state.capturedBy.A.angel, 1);
  assert.strictEqual(b.state.capturedBy.A.angel, 1);
  assert.deepStrictEqual(pair.captures.A, [{ byMe: true, pieceId: 'B4', type: 'angel' }]);
  assert.deepStrictEqual(pair.captures.B, [{ byMe: false, pieceId: 'B4', type: 'angel' }]);
  assert.strictEqual(a.state.turn, 'B');
  assert.strictEqual(b.state.turn, 'B');
  assert.strictEqual(a.pendingCapture, null);
});

test('開示をごまかすと相手側で不正が検出される', async () => {
  // B が reveal の種類を反転させる（nonceは元のままなのでハッシュ不一致になる）
  const pair = makePair({
    tamperB: (m) => (m.t === 'reveal' ? { ...m, type: m.type === 'angel' ? 'demon' : 'angel' } : m),
  });
  await startGame(pair);
  const { a, b } = pair;
  a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 3 } }); await flush();
  b.doMove({ kind: 'move', pieceId: 'B0', to: { x: 0, y: 0 } }); await flush();
  a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 2 } }); await flush();
  b.doMove({ kind: 'move', pieceId: 'B1', to: { x: 1, y: 0 } }); await flush();
  a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 1 } }); await flush();
  assert.strictEqual(a.phase, 'finished');
  assert.strictEqual(a.state.winner, 'A');
  assert.strictEqual(a.state.winReason, 'cheat');
});

test('手番でない側の手・ルール外の手は適用されない', async () => {
  const pair = makePair();
  await startGame(pair);
  const { a, b } = pair;
  // B は手番でないので doMove が false
  assert.strictEqual(b.doMove({ kind: 'move', pieceId: 'B0', to: { x: 0, y: 0 } }), false);
  // A に B 名義の偽メッセージを直接送っても moveCount は増えない
  const before = a.state.moveCount;
  await a.onMessage({ t: 'move', move: { kind: 'move', pieceId: 'A0', to: { x: 1, y: 3 } } });
  await flush();
  assert.strictEqual(a.state.moveCount, before);
  // 2マス移動も拒否される
  assert.strictEqual(a.doMove({ kind: 'move', pieceId: 'A0', to: { x: 1, y: 2 } }), false);
});

test('投了と再戦: 両側で終了し、合意で配置に戻り、第2局は先手交代', async () => {
  const pair = makePair();
  await startGame(pair);
  const { a, b } = pair;
  assert.strictEqual(a.resign(), true);
  await flush();
  assert.strictEqual(a.phase, 'finished');
  assert.strictEqual(b.phase, 'finished');
  assert.strictEqual(b.state.winner, 'B');
  // 終局時の全開示検証が両側とも OK
  assert.deepStrictEqual(pair.verifies.A, [true]);
  assert.deepStrictEqual(pair.verifies.B, [true]);
  // 再戦: 片方だけでは始まらず、合意でリセット
  a.requestRematch();
  await flush();
  assert.strictEqual(a.phase, 'finished');
  assert.ok(pair.logs.B.includes('__rematchOffer__'));
  b.requestRematch();
  await flush();
  assert.strictEqual(a.phase, 'placement');
  assert.strictEqual(b.phase, 'placement');
  await startGame(pair);
  assert.strictEqual(a.gameNumber, 2);
  assert.strictEqual(a.state.turn, 'B'); // 第2局はBが先手
  assert.strictEqual(b.state.turn, 'B');
});

test('ランダム対局が終局まで進み、両側の勝者と検証が一致する', async () => {
  const pair = makePair();
  await startGame(pair);
  const { a, b } = pair;
  let steps = 0;
  while (a.phase === 'playing' && steps < 3000) {
    const s = a.state.turn === 'A' ? a : b;
    const state = s.state;
    const moves = [];
    for (const p of state.pieces.filter((p) => p.alive && p.owner === s.me)) {
      if (s.ownTypes()[p.id] === 'angel' && G.isOnTargetExit(s.me, p.x, p.y)) {
        moves.push({ kind: 'exit', pieceId: p.id, score: 100 });
        continue;
      }
      for (const d of G.legalDestinations(state, p.id)) {
        moves.push({ kind: 'move', pieceId: p.id, to: { x: d.x, y: d.y }, score: d.captures ? 10 + Math.random() : Math.random() });
      }
    }
    assert.ok(moves.length > 0, '指せる手があるはず');
    moves.sort((x, y) => y.score - x.score);
    const top = moves[0];
    assert.strictEqual(s.doMove({ kind: top.kind, pieceId: top.pieceId, to: top.to }), true);
    await flush(4);
    steps++;
  }
  assert.strictEqual(a.phase, 'finished', `3000手以内に終局する (steps=${steps})`);
  assert.strictEqual(b.phase, 'finished');
  assert.strictEqual(a.state.winner, b.state.winner);
  assert.ok(pair.verifies.A.includes(true));
  assert.ok(pair.verifies.B.includes(true));
});

test('validateMsg: 壊れたメッセージを弾く', () => {
  assert.strictEqual(validateMsg(null, 'A'), false);
  assert.strictEqual(validateMsg([], 'A'), false);
  assert.strictEqual(validateMsg({ t: 'unknown' }, 'A'), false);
  assert.strictEqual(validateMsg({ t: 'reveal', pieceId: 'A0', type: 'angel', nonce: 'zz' }, 'A'), false);
  assert.strictEqual(validateMsg({ t: 'reveal', pieceId: 'B0', type: 'angel', nonce: 'a'.repeat(32) }, 'A'), false); // 相手の駒ではない
  assert.strictEqual(validateMsg({ t: 'reveal', pieceId: 'A0', type: 'angel', nonce: 'a'.repeat(32) }, 'A'), true);
  assert.strictEqual(validateMsg({ t: 'move', move: { kind: 'move', pieceId: 'A0', to: { x: 6, y: 0 } } }, 'A'), false);
  assert.strictEqual(validateMsg({ t: 'resign' }, 'A'), true);
});
