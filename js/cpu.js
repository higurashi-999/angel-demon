'use strict';
/*
 * みやぶれ！てんしとあくま — CPU対戦の思考ルーチン
 * 自分の駒の種類は知っているが、相手の駒の種類は知らない前提で手を選ぶ。
 * 強さは3段階:
 *   1 よわい … 初期の貪欲評価＋ときどき最善手を外す
 *   2 ふつう … 捕獲の期待値（悪魔リスク）・脱出阻止・天使を吊るさない等を織り込んだ1手評価
 *   3 つよい … 2の評価に先読み（相手の脱出脅威・捕獲への応答・自分の脱出レース）を加味
 */
(function (global) {
  const G = global.Geister || (typeof require !== 'undefined' ? require('./game.js') : null);
  const other = (p) => (p === 'A' ? 'B' : 'A');

  /* 配置（天使4・悪魔4）を placementCells の順で返す。level>=2 は定石寄りの型も使う */
  function randomTypes(rand = Math.random, level = 2) {
    const templates = [
      ['demon', 'angel', 'angel', 'demon', 'angel', 'demon', 'demon', 'angel'],
      ['angel', 'demon', 'demon', 'angel', 'demon', 'angel', 'angel', 'demon'],
    ];
    if (level >= 2 && rand() < 0.6) {
      const t = templates[Math.floor(rand() * templates.length)].slice();
      if (rand() < 0.5) t.reverse();
      return t;
    }
    const types = ['angel', 'angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'demon'];
    for (let i = types.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [types[i], types[j]] = [types[j], types[i]];
    }
    return types;
  }

  const distToExits = (exits, x, y) => Math.min(...exits.map((e) => Math.abs(e.x - x) + Math.abs(e.y - y)));
  const adjacentEnemies = (pieces, me, x, y) =>
    pieces.filter((q) => q.alive && q.owner !== me && Math.abs(q.x - x) + Math.abs(q.y - y) === 1);

  /* 初期の貪欲評価（よわい用） */
  function legacyScore(state, me, myTypes, p, d, rand) {
    let score = rand() * 6;
    if (d.captures) score += 22 + rand() * 10;
    const exits = G.targetExits(me);
    if (myTypes[p.id] === 'angel') score += (distToExits(exits, p.x, p.y) - distToExits(exits, d.x, d.y)) * 9;
    if (myTypes[p.id] === 'demon') score += (p.y - d.y) * (me === 'B' ? -3 : 3) + (d.captures ? 6 : 0);
    return score;
  }

  /*
   * ふつう/つよい用の1手評価。指してはいけない手は null を返す。
   * 捕獲は「残り構成比」からの期待値で評価し、悪魔を3体取っているときは
   * 脱出阻止以外の捕獲をしない。
   */
  function smartScore(state, me, myTypes, p, d, rand, level) {
    const type = myTypes[p.id];
    const myCap = state.capturedBy[me];
    let score = rand() * (level >= 3 ? 2 : 3);
    if (d.captures) {
      const target = G.pieceAt(state, d.x, d.y);
      const onItsExit = target && G.targetExits(target.owner).some((e) => e.x === d.x && e.y === d.y);
      if (onItsExit) {
        score += 5000; // 相手の脱出を止める手は最優先級
      } else {
        if (myCap.demon >= 3) return null; // あと1体悪魔を取ると負け。賭けはしない
        const poolA = 4 - myCap.angel;
        const poolD = 4 - myCap.demon;
        const pA = poolA / (poolA + poolD);
        score += pA * 30 - (1 - pA) * (16 + myCap.demon * 20);
      }
    }
    const exits = G.targetExits(me);
    if (type === 'angel') {
      const before = distToExits(exits, p.x, p.y);
      const after = distToExits(exits, d.x, d.y);
      score += (before - after) * 10;
      if (after === 0) score += 260; // 脱出マスに到達（次手で脱出）
      if (adjacentEnemies(state.pieces, me, d.x, d.y).length) score -= 16; // 取られにいく動きは避ける
      if (adjacentEnemies(state.pieces, me, p.x, p.y).length
        && !adjacentEnemies(state.pieces, me, d.x, d.y).length) score += 8; // 脅威から離脱
    } else {
      if (adjacentEnemies(state.pieces, me, d.x, d.y).length) score += 7; // 悪魔は囮として差し出す
      const fwd = me === 'A' ? p.y - d.y : d.y - p.y;
      score += fwd * 2;
    }
    return score;
  }

  /* つよい用: その手を指した後の局面で、相手の脅威と自分の見込みを差し引く */
  function lookahead(state, me, myTypes, p, d) {
    const opp = other(me);
    const pieces = state.pieces.map((q) => ({ ...q }));
    const mp = pieces.find((q) => q.id === p.id);
    if (d.captures) {
      const tp = pieces.find((q) => q.alive && q.owner === opp && q.x === d.x && q.y === d.y);
      if (tp) tp.alive = false;
    }
    mp.x = d.x;
    mp.y = d.y;
    let adj = 0;
    // 相手の脱出脅威: 脱出マスに残った相手駒は、天使なら相手の次手で負け
    const theirAngels = 4 - state.capturedBy[me].angel;
    const theirTotal = theirAngels + (4 - state.capturedBy[me].demon);
    const pTheirAngel = theirTotal > 0 ? theirAngels / theirTotal : 0;
    for (const e of G.targetExits(opp)) {
      if (pieces.some((q) => q.alive && q.owner === opp && q.x === e.x && q.y === e.y)) {
        adj -= 9000 * pTheirAngel;
      }
    }
    // 相手が私の駒を取りにくる見込み（相手視点の期待値が高いほど取られやすい）
    const oppCap = state.capturedBy[opp];
    const myAngelsLeft = 4 - oppCap.angel;
    const myTotalLeft = myAngelsLeft + (4 - oppCap.demon);
    const pMyAngel = myTotalLeft > 0 ? myAngelsLeft / myTotalLeft : 0;
    const willing = oppCap.demon >= 3 ? 0.05 : (pMyAngel >= 0.34 ? 0.85 : 0.3);
    for (const q of pieces.filter((q) => q.alive && q.owner === me)) {
      if (!adjacentEnemies(pieces, opp, q.x, q.y).length) continue;
      adj += myTypes[q.id] === 'angel' ? -120 * willing : 70 * willing;
    }
    // 自分の天使が脱出マスに届いた価値（取られる位置なら割り引く）
    if (myTypes[p.id] === 'angel' && G.isOnTargetExit(me, d.x, d.y)) {
      adj += adjacentEnemies(pieces, me, d.x, d.y).length ? 60 : 300;
    }
    return adj;
  }

  /* session（CPU側）の今の手番に手を1つ指す。指したら true */
  function takeTurn(session, rand = Math.random, level = 2) {
    const state = session.state;
    if (!state || state.winner || state.turn !== session.me || session.phase !== 'playing') return false;
    const me = session.me;
    const myTypes = session.ownTypes();
    const candidates = [];
    for (const p of state.pieces.filter((q) => q.alive && q.owner === me)) {
      const type = myTypes[p.id];
      if (type === 'angel' && G.isOnTargetExit(me, p.x, p.y)) {
        candidates.push({ score: 10000, move: { kind: 'exit', pieceId: p.id } });
        continue;
      }
      for (const d of G.legalDestinations(state, p.id)) {
        let score;
        if (level <= 1) {
          score = legacyScore(state, me, myTypes, p, d, rand);
        } else {
          score = smartScore(state, me, myTypes, p, d, rand, level);
          if (score === null) continue;
          if (level >= 3) score += lookahead(state, me, myTypes, p, d);
        }
        candidates.push({ score, move: { kind: 'move', pieceId: p.id, to: { x: d.x, y: d.y } } });
      }
    }
    if (!candidates.length) return false;
    // よわいは 25% の確率で最善手を外す
    if (level <= 1 && candidates.length > 1 && rand() < 0.25) {
      return session.doMove(candidates[Math.floor(rand() * candidates.length)].move);
    }
    candidates.sort((a, b) => b.score - a.score);
    return session.doMove(candidates[0].move);
  }

  const api = { randomTypes, takeTurn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ADCpu = api;
})(typeof window !== 'undefined' ? window : globalThis);
