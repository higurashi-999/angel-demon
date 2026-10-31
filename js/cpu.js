'use strict';
/*
 * 天使と悪魔 — CPU対戦の思考ルーチン
 * 自分の駒の種類は知っているが、相手の駒の種類は知らない前提で手を選ぶ
 * （捕獲は種類不明の賭けとして均等に評価する）。
 */
(function (global) {
  const G = global.Geister || (typeof require !== 'undefined' ? require('./game.js') : null);

  /* ランダムな配置（天使4・悪魔4）を placementCells の順で返す */
  function randomTypes(rand = Math.random) {
    const types = ['angel', 'angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'demon'];
    for (let i = types.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [types[i], types[j]] = [types[j], types[i]];
    }
    return types;
  }

  /* session（CPU側）の今の手番に最善手を1つ指す。指したら true */
  function takeTurn(session, rand = Math.random) {
    const state = session.state;
    if (!state || state.winner || state.turn !== session.me || session.phase !== 'playing') return false;
    const me = session.me;
    const myTypes = session.ownTypes();
    const candidates = [];
    for (const p of state.pieces.filter((p) => p.alive && p.owner === me)) {
      const type = myTypes[p.id];
      if (type === 'angel' && G.isOnTargetExit(me, p.x, p.y)) {
        candidates.push({ score: 1000, move: { kind: 'exit', pieceId: p.id } });
        continue;
      }
      for (const d of G.legalDestinations(state, p.id)) {
        let score = rand() * 6;
        if (d.captures) score += 22 + rand() * 10;
        const exits = G.targetExits(me);
        const dist = (x, y) => Math.min(...exits.map((e) => Math.abs(e.x - x) + Math.abs(e.y - y)));
        if (type === 'angel') score += (dist(p.x, p.y) - dist(d.x, d.y)) * 9;
        if (type === 'demon') score += (p.y - d.y) * (me === 'B' ? -3 : 3) + (d.captures ? 6 : 0);
        candidates.push({ score, move: { kind: 'move', pieceId: p.id, to: { x: d.x, y: d.y } } });
      }
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => b.score - a.score);
    return session.doMove(candidates[0].move);
  }

  const api = { randomTypes, takeTurn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ADCpu = api;
})(typeof window !== 'undefined' ? window : globalThis);
