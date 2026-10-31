'use strict';
/*
 * 天使と悪魔 — 対戦セッション（プロトコルと進行の状態機械）
 * DOMにも PeerJS にも依存しない。transport は send 関数として注入され、
 * 描画や演出は events コールバックで外へ通知する（単体テスト可能にするため）。
 *
 * セキュリティ（docs/ARCHITECTURE.md）:
 * - 駒の種類は自分の端末だけが保持し、相手には位置とハッシュのみ送る
 * - 配置時に SHA-256 コミットメントを交換し、捕獲・脱出・終局時に開示して検証する
 * - 受信メッセージは全てスキーマ検証＋ルール検証を通してから状態へ適用する
 */
(function (global) {
  const G = global.Geister || (typeof require !== 'undefined' ? require('./game.js') : null);

  const HEX64 = /^[0-9a-f]{64}$/;
  const HEX32 = /^[0-9a-f]{32}$/;
  function isIntIn(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

  /* 受信メッセージのスキーマ検証（sender 視点の駒IDで検証する） */
  function validateMsg(m, sender) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    try { if (JSON.stringify(m).length > 16384) return false; } catch { return false; }
    const ids = Array.from({ length: 8 }, (_, i) => G.pieceId(sender, i));
    switch (m.t) {
      case 'setup': {
        if (m.v !== 1) return false;
        if (!m.placements || !m.commitments) return false;
        for (const id of ids) {
          const p = m.placements[id];
          if (!p || !G.isPlacementCell(sender, p.x, p.y)) return false;
          if (!HEX64.test(m.commitments[id] || '')) return false;
        }
        return G.validatePlacements(sender, m.placements) === null;
      }
      case 'move': {
        const mv = m.move;
        if (!mv || typeof mv !== 'object') return false;
        if (!ids.includes(mv.pieceId)) return false;
        if (mv.kind === 'move') return !!(mv.to && isIntIn(mv.to.x, 0, 5) && isIntIn(mv.to.y, 0, 5));
        if (mv.kind === 'exit') {
          return !!(m.reveal && G.TYPES.includes(m.reveal.type) && HEX32.test(m.reveal.nonce || ''));
        }
        return false;
      }
      case 'reveal':
        return ids.includes(m.pieceId) && G.TYPES.includes(m.type) && HEX32.test(m.nonce || '');
      case 'fullReveal': {
        if (!m.types || !m.nonces) return false;
        return ids.every((id) => G.TYPES.includes(m.types[id]) && HEX32.test(m.nonces[id] || ''));
      }
      case 'resign': case 'rematch':
        return true;
      default:
        return false;
    }
  }

  class GameSession {
    /*
     * opts: { me:'A'|'B', send(msg), hash(text)->Promise<hex>, randomHex(bytes)->hex,
     *         events: {...}, closeTransport() }
     */
    constructor(opts) {
      this.me = opts.me;
      this.opp = G.other(this.me);
      this._send = opts.send;
      this._hash = opts.hash;
      this._randomHex = opts.randomHex;
      this._events = opts.events || {};
      this._closeTransport = opts.closeTransport || null;

      this.phase = 'placement'; // placement | playing | finished
      this.gameNumber = 0;
      this.firstPlayer = 'A';
      this.state = null;
      this.pendingCapture = null;
      this.capturedInfo = {};
      this.myTypes = {};
      this.myNonces = {};
      this.myCommitments = {};
      this.myPlacements = null;
      this.oppCommitments = null;
      this.oppPlacements = null;
      this.mySetupSent = false;
      this.oppSetupReceived = false;
      this.oppFullReveal = null;
      this.verifyDone = false;
      this.myRematch = false;
      this.oppRematch = false;
      this.invalidMsgCount = 0;
      this.revealTimer = null;
    }

    _ev(name, arg) { const h = this._events[name]; if (h) h(arg); }
    _log(msg) { this._ev('onLog', msg); }
    async _commitmentOf(id, type, nonce) { return this._hash(G.commitmentInput(id, type, nonce)); }

    /* 自分の駒の種類（自分の端末内でのみ使う。CPU脳みそ用） */
    ownTypes() { return this.myTypes; }
    get isPlaying() { return this.phase === 'playing'; }

    /* ---------- 配置 ---------- */
    async confirmSetup(typesInCellOrder) {
      if (this.mySetupSent) return false;
      const cells = G.placementCells(this.me);
      const placements = {};
      cells.forEach((c, i) => { placements[G.pieceId(this.me, i)] = { x: c.x, y: c.y }; });
      const err = G.validateTypes(typesInCellOrder) || G.validatePlacements(this.me, placements);
      if (err) { this._log(err); return false; }
      this.myPlacements = placements;
      this.myTypes = {}; this.myNonces = {}; this.myCommitments = {};
      for (let i = 0; i < 8; i++) {
        const id = G.pieceId(this.me, i);
        this.myTypes[id] = typesInCellOrder[i];
        this.myNonces[id] = this._randomHex(16);
        this.myCommitments[id] = await this._commitmentOf(id, this.myTypes[id], this.myNonces[id]);
      }
      this.mySetupSent = true;
      this._send({ t: 'setup', v: 1, placements: this.myPlacements, commitments: this.myCommitments });
      this._log('配置を確定しました');
      this._maybeStartGame();
      this._ev('onTurnChange');
      return true;
    }

    /* ---------- 自分の手 ---------- */
    doMove(move) {
      if (this.phase !== 'playing' || !this.state || this.pendingCapture) return false;
      const res = G.validateMove(this.state, this.me, move);
      if (!res.ok) return false;
      if (move.kind === 'exit') {
        if (this.myTypes[move.pieceId] !== 'angel') { this._log('悪魔は脱出できません'); return false; }
        G.applyMove(this.state, move);
        this.capturedInfo[move.pieceId] = 'angel';
        this._send({ t: 'move', move, reveal: { type: 'angel', nonce: this.myNonces[move.pieceId] } });
        G.recordExit(this.state, this.me);
        this._log('あなたの天使が脱出しました！');
        this._ev('onExit', { byMe: true });
        this._finishGame();
        return true;
      }
      const { captured } = G.applyMove(this.state, move);
      // pendingCapture は送信前に立てる（同期的な transport では相手の reveal が
      // この関数の完了より先に届きうるため）
      if (captured) this.pendingCapture = { capturedId: captured.id };
      this._send({ t: 'move', move });
      if (captured) {
        this._log('相手の駒を捕獲。種類の開示を待っています…');
        this.revealTimer = setTimeout(() => {
          if (this.pendingCapture) this._log('相手から開示が届きません。接続状態を確認してください');
        }, 15000);
        this._ev('onTurnChange');
      } else {
        G.endTurn(this.state);
        this._ev('onTurnChange');
      }
      return true;
    }

    resign() {
      if (this.phase !== 'playing' || !this.state || this.state.winner) return false;
      this.state.winner = this.opp;
      this.state.winReason = 'resign';
      this._send({ t: 'resign' });
      this._finishGame();
      return true;
    }

    /* ---------- 再戦 ---------- */
    requestRematch() {
      if (this.phase !== 'finished') return;
      this.myRematch = true;
      this._send({ t: 'rematch' });
      if (this.oppRematch) this._resetForRematch();
    }

    _resetForRematch() {
      this.myTypes = {}; this.myNonces = {}; this.myCommitments = {}; this.myPlacements = null;
      this.oppCommitments = null; this.oppPlacements = null;
      this.mySetupSent = false; this.oppSetupReceived = false;
      this.state = null; this.pendingCapture = null; this.capturedInfo = {};
      this.oppFullReveal = null; this.verifyDone = false;
      this.myRematch = false; this.oppRematch = false;
      this.phase = 'placement';
      this._ev('onRematchStart');
      this._ev('onTurnChange');
    }

    /* ---------- 受信 ---------- */
    async onMessage(m) {
      if (!validateMsg(m, this.opp)) {
        this.invalidMsgCount++;
        this._ev('onInvalid', this.invalidMsgCount);
        if (this.invalidMsgCount > 5) {
          this._log('不正なデータを繰り返し受信したため接続を終了しました');
          if (this._closeTransport) this._closeTransport();
        }
        return;
      }
      switch (m.t) {
        case 'setup': {
          if (this.oppSetupReceived) return;
          this.oppSetupReceived = true;
          this.oppPlacements = m.placements;
          this.oppCommitments = m.commitments;
          this._log('相手の配置が確定しました');
          this._maybeStartGame();
          this._ev('onTurnChange');
          break;
        }
        case 'move': {
          if (this.phase !== 'playing' || !this.state) return;
          const res = G.validateMove(this.state, this.opp, m.move);
          if (!res.ok) return; // ルール外の手は黙って破棄
          if (m.move.kind === 'exit') {
            const expect = this.oppCommitments[m.move.pieceId];
            const actual = await this._commitmentOf(m.move.pieceId, m.reveal.type, m.reveal.nonce);
            if (actual !== expect || m.reveal.type !== 'angel') { this._cheatAbort(); return; }
            this.capturedInfo[m.move.pieceId] = 'angel';
            G.applyMove(this.state, m.move);
            G.recordExit(this.state, this.opp);
            this._log('相手の天使が脱出しました');
            this._ev('onExit', { byMe: false });
            this._finishGame();
            return;
          }
          const { captured } = G.applyMove(this.state, m.move);
          if (captured) {
            const type = this.myTypes[captured.id]; // 取られたのは自分の駒なので種類を知っている
            this.capturedInfo[captured.id] = type;
            this._log(`相手があなたの${type === 'angel' ? '天使😇' : '悪魔😈'}を捕獲しました`);
            G.recordCapture(this.state, this.opp, type);
            this._ev('onCapture', { byMe: false, pieceId: captured.id, type });
            this._send({ t: 'reveal', pieceId: captured.id, type, nonce: this.myNonces[captured.id] });
            if (this.state.winner) { this._finishGame(); return; }
          } else {
            this._log('相手が駒を動かしました');
          }
          G.endTurn(this.state);
          this._ev('onTurnChange');
          break;
        }
        case 'reveal': {
          if (!this.pendingCapture || this.pendingCapture.capturedId !== m.pieceId) return;
          clearTimeout(this.revealTimer);
          const expect = this.oppCommitments[m.pieceId];
          const actual = await this._commitmentOf(m.pieceId, m.type, m.nonce);
          if (actual !== expect) { this._cheatAbort(); return; }
          this.capturedInfo[m.pieceId] = m.type;
          this._log(`相手の${m.type === 'angel' ? '天使😇' : '悪魔😈'}を捕獲しました`);
          const capturedId = m.pieceId;
          this.pendingCapture = null;
          G.recordCapture(this.state, this.me, m.type);
          this._ev('onCapture', { byMe: true, pieceId: capturedId, type: m.type });
          if (this.state.winner) { this._finishGame(); return; }
          G.endTurn(this.state);
          this._ev('onTurnChange');
          break;
        }
        case 'fullReveal': {
          this.oppFullReveal = m;
          this._verifyOpponent();
          break;
        }
        case 'resign': {
          if (this.phase === 'playing' && this.state && !this.state.winner) {
            this.state.winner = this.me;
            this.state.winReason = 'resign';
            this._log('相手が投了しました');
            this._finishGame();
          }
          break;
        }
        case 'rematch': {
          this.oppRematch = true;
          if (this.myRematch) this._resetForRematch();
          else this._ev('onRematchOffer');
          break;
        }
      }
    }

    /* ---------- 進行 ---------- */
    _maybeStartGame() {
      if (!this.mySetupSent || !this.oppSetupReceived || this.phase !== 'placement') return;
      this.gameNumber++;
      this.firstPlayer = this.gameNumber % 2 === 1 ? 'A' : 'B';
      this.state = G.createGame({ ...this.myPlacements, ...this.oppPlacements }, this.firstPlayer);
      this.phase = 'playing';
      this.pendingCapture = null;
      this.capturedInfo = {};
      this.oppFullReveal = null;
      this.verifyDone = false;
      this.myRematch = false;
      this.oppRematch = false;
      this._log(`第${this.gameNumber}局開始。先手は${this.firstPlayer === this.me ? 'あなた' : '相手'}です`);
      this._ev('onGameStart', { gameNumber: this.gameNumber, firstPlayer: this.firstPlayer });
      this._ev('onTurnChange');
    }

    _finishGame() {
      this.phase = 'finished';
      this._send({ t: 'fullReveal', types: this.myTypes, nonces: this.myNonces });
      if (this.oppFullReveal) this._verifyOpponent();
      this._ev('onGameEnd', {
        winner: this.state.winner,
        winReason: this.state.winReason,
        won: this.state.winner === this.me,
      });
      this._ev('onTurnChange');
    }

    _cheatAbort() {
      if (this.state) { this.state.winner = this.me; this.state.winReason = 'cheat'; }
      this._log('相手の開示が配置時のハッシュと一致しませんでした（不正検出）');
      this._finishGame();
    }

    async _verifyOpponent() {
      if (!this.oppFullReveal || !this.oppCommitments || this.verifyDone) return;
      this.verifyDone = true;
      let ok = true;
      for (let i = 0; i < 8; i++) {
        const id = G.pieceId(this.opp, i);
        const h = await this._commitmentOf(id, this.oppFullReveal.types[id], this.oppFullReveal.nonces[id]);
        if (h !== this.oppCommitments[id]) ok = false;
        if (this.capturedInfo[id] && this.capturedInfo[id] !== this.oppFullReveal.types[id]) ok = false;
      }
      this._ev('onVerify', ok);
    }
  }

  const api = { GameSession, validateMsg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ADSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
