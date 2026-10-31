'use strict';
/*
 * 天使と悪魔（ガイスター互換ルール）— 純粋ロジック
 * 盤面座標: x=0..5（左→右）, y=0..5（上→下）。絶対座標で管理し、表示時に自陣が下になるよう変換する。
 * プレイヤーA（ホスト）は下段（y=4,5）が自陣、プレイヤーB（ゲスト）は上段（y=0,1）が自陣。
 * 駒の種類（angel/demon）はこのモジュールでは扱わない。種類は各端末だけが保持し、
 * コミットメント（SHA-256ハッシュ）で相手に証明する（docs/ARCHITECTURE.md 参照）。
 */
(function (global) {
  const SIZE = 6;
  const TYPES = ['angel', 'demon'];

  function other(player) { return player === 'A' ? 'B' : 'A'; }

  function placementCells(player) {
    const rows = player === 'A' ? [4, 5] : [0, 1];
    const cells = [];
    for (const y of rows) for (let x = 1; x <= 4; x++) cells.push({ x, y });
    return cells;
  }

  function isPlacementCell(player, x, y) {
    return placementCells(player).some((c) => c.x === x && c.y === y);
  }

  /* そのプレイヤーが目指す脱出マス（相手陣地の左右の角） */
  function targetExits(player) {
    return player === 'A' ? [{ x: 0, y: 0 }, { x: 5, y: 0 }] : [{ x: 0, y: 5 }, { x: 5, y: 5 }];
  }

  function isOnTargetExit(player, x, y) {
    return targetExits(player).some((c) => c.x === x && c.y === y);
  }

  function pieceId(player, index) { return player + index; } // A0..A7 / B0..B7

  /*
   * placements: { A0:{x,y}, ..., A7:{x,y}, B0:{x,y}, ... } の公開配置から初期状態を作る
   * types は含めない（公開情報のみ）。
   */
  function createGame(placements, firstPlayer) {
    const pieces = [];
    for (const player of ['A', 'B']) {
      for (let i = 0; i < 8; i++) {
        const id = pieceId(player, i);
        const pos = placements[id];
        if (!pos) throw new Error('missing placement: ' + id);
        pieces.push({ id, owner: player, x: pos.x, y: pos.y, alive: true });
      }
    }
    return {
      pieces,
      turn: firstPlayer,
      // capturedBy[P] = Pが捕獲した「相手の駒」の種類別カウント（公開済みの情報のみ）
      capturedBy: { A: { angel: 0, demon: 0 }, B: { angel: 0, demon: 0 } },
      winner: null,
      winReason: null, // 'capture-angels' | 'capture-demons' | 'exit' | 'resign'
      moveCount: 0,
    };
  }

  function pieceAt(state, x, y) {
    return state.pieces.find((p) => p.alive && p.x === x && p.y === y) || null;
  }

  function getPiece(state, id) {
    return state.pieces.find((p) => p.id === id) || null;
  }

  /* 配置バリデーション: 種類の内訳は呼び出し側の端末内でのみ検証する */
  function validateTypes(types) {
    if (!Array.isArray(types) || types.length !== 8) return '駒は8個必要です';
    const angels = types.filter((t) => t === 'angel').length;
    const demons = types.filter((t) => t === 'demon').length;
    if (angels !== 4 || demons !== 4) return '天使4体・悪魔4体にしてください';
    return null;
  }

  function validatePlacements(player, placements) {
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
      const pos = placements[pieceId(player, i)];
      if (!pos) return '未配置の駒があります';
      if (!isPlacementCell(player, pos.x, pos.y)) return '自陣の8マス内に配置してください';
      const key = pos.x + ',' + pos.y;
      if (seen.has(key)) return '同じマスに2体置けません';
      seen.add(key);
    }
    return null;
  }

  /* 上下左右1マスの移動先（自駒のあるマスは除く）。盤外への移動は脱出アクションとして別扱い。 */
  function legalDestinations(state, id) {
    const piece = getPiece(state, id);
    if (!piece || !piece.alive) return [];
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const out = [];
    for (const d of dirs) {
      const nx = piece.x + d.x, ny = piece.y + d.y;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
      const occ = pieceAt(state, nx, ny);
      if (occ && occ.owner === piece.owner) continue;
      out.push({ x: nx, y: ny, captures: occ ? occ.id : null });
    }
    return out;
  }

  /*
   * 公開情報だけで検証できる移動バリデーション。
   * move: {kind:'move', pieceId, to:{x,y}} | {kind:'exit', pieceId}
   * 脱出の「天使であること」はコミットメント開示で別途検証する。
   */
  function validateMove(state, player, move) {
    if (state.winner) return { ok: false, reason: '対戦は終了しています' };
    if (state.turn !== player) return { ok: false, reason: '相手の手番です' };
    if (!move || typeof move !== 'object') return { ok: false, reason: '不正なデータです' };
    const piece = getPiece(state, move.pieceId);
    if (!piece || !piece.alive) return { ok: false, reason: 'その駒は存在しません' };
    if (piece.owner !== player) return { ok: false, reason: '自分の駒ではありません' };
    if (move.kind === 'exit') {
      if (!isOnTargetExit(player, piece.x, piece.y)) return { ok: false, reason: '脱出マスの上ではありません' };
      return { ok: true, piece };
    }
    if (move.kind === 'move') {
      const to = move.to || {};
      if (!Number.isInteger(to.x) || !Number.isInteger(to.y)) return { ok: false, reason: '移動先が不正です' };
      const legal = legalDestinations(state, piece.id).some((d) => d.x === to.x && d.y === to.y);
      if (!legal) return { ok: false, reason: 'そこには移動できません' };
      const occ = pieceAt(state, to.x, to.y);
      return { ok: true, piece, captured: occ || null };
    }
    return { ok: false, reason: '未知のアクションです' };
  }

  /* 移動を公開状態へ適用。捕獲した駒を返す（種類の確定は recordCapture で別途行う）。 */
  function applyMove(state, move) {
    const piece = getPiece(state, move.pieceId);
    let captured = null;
    if (move.kind === 'move') {
      captured = pieceAt(state, move.to.x, move.to.y);
      if (captured) captured.alive = false;
      piece.x = move.to.x; piece.y = move.to.y;
    } else if (move.kind === 'exit') {
      piece.alive = false;
      piece.x = -1; piece.y = -1;
    }
    state.moveCount++;
    return { piece, captured };
  }

  /*
   * 捕獲した駒の種類が開示されたら記録し、勝敗を判定する。
   * - 相手の天使を4体捕獲 → 捕獲した側の勝利
   * - 相手の悪魔を4体捕獲 → 捕獲した側の敗北（＝相手の勝利）
   */
  function recordCapture(state, mover, capturedType) {
    state.capturedBy[mover][capturedType]++;
    if (capturedType === 'angel' && state.capturedBy[mover].angel >= 4) {
      state.winner = mover; state.winReason = 'capture-angels';
    } else if (capturedType === 'demon' && state.capturedBy[mover].demon >= 4) {
      state.winner = other(mover); state.winReason = 'capture-demons';
    }
    return state.winner;
  }

  function recordExit(state, player) {
    state.winner = player; state.winReason = 'exit';
    return state.winner;
  }

  function endTurn(state) {
    if (!state.winner) state.turn = other(state.turn);
  }

  /* コミットメント入力文字列。SHA-256 は呼び出し側（WebCrypto / Node crypto）で行う。 */
  function commitmentInput(id, type, nonce) {
    return id + '|' + type + '|' + nonce;
  }

  const api = {
    SIZE, TYPES, other, placementCells, isPlacementCell, targetExits, isOnTargetExit,
    pieceId, createGame, pieceAt, getPiece, validateTypes, validatePlacements,
    legalDestinations, validateMove, applyMove, recordCapture, recordExit, endTurn,
    commitmentInput,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Geister = api;
})(typeof window !== 'undefined' ? window : globalThis);
