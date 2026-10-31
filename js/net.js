'use strict';
/*
 * 天使と悪魔 — 接続層（PeerJS / WebRTC のラッパー）
 * 役割: 部屋の作成・参加、シグナリング再接続、ICE切断の猶予判定、参加リトライ。
 * ゲームのプロトコルは session.js が担当し、ここは「つながる/切れる」だけを見る。
 *
 * ICE: STUN に加えて無料の公開 TURN（Open Relay Project）も使う。
 * モバイル回線同士（対称型NAT）では STUN だけだと直接接続できないことが多く、
 * その場合は TURN が暗号化済みデータを中継する（中身は読めず、保存もされない）。
 */
(function (global) {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  function peerIdFor(code) { return 'ad-geister-' + String(code).toLowerCase(); }
  function normalizeCode(raw) { return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  class Net {
    constructor(opts = {}) {
      this.PeerCtor = opts.PeerCtor || global.Peer;
      if (!this.PeerCtor) throw new Error('PeerJS が読み込まれていません');
      this.iceServers = opts.iceServers || ICE_SERVERS;
      this.connectTimeoutMs = opts.connectTimeoutMs != null ? opts.connectTimeoutMs : 20000;
      this.disconnectGraceMs = opts.disconnectGraceMs != null ? opts.disconnectGraceMs : 6000;
      this.maxJoinRetries = opts.maxJoinRetries != null ? opts.maxJoinRetries : 3;
      this.retryDelayMs = opts.retryDelayMs != null ? opts.retryDelayMs : 3000;
      this._setTimeout = opts.setTimeoutFn || setTimeout;
      this._clearTimeout = opts.clearTimeoutFn || clearTimeout;
      this.handlers = {};
      /* 対戦進行中に新しい接続を受け入れるか(app側が設定)。null なら常に受け入れる */
      this.acceptPolicy = null;
      this.peer = null;
      this.conn = null;
      this.connOpen = false;
      this.role = null;
      this.code = null;
      this._joinAttempts = 0;
      this._graceTimer = null;
      this._connectTimer = null;
      this._destroyed = false;
    }

    on(name, fn) { this.handlers[name] = fn; }
    _emit(name, arg) { const h = this.handlers[name]; if (h) h(arg); }
    _peerOpts() { return { debug: 0, config: { iceServers: this.iceServers } }; }

    /* ---------- ホスト ---------- */
    host(code) {
      this.role = 'host';
      this.code = code;
      this._destroyed = false;
      const peer = (this.peer = new this.PeerCtor(peerIdFor(code), this._peerOpts()));
      peer.on('open', () => this._emit('hostReady', code));
      peer.on('connection', (c) => this._accept(c));
      peer.on('disconnected', () => this._reconnectSignaling());
      peer.on('error', (e) => this._onPeerError(e));
    }

    _accept(c) {
      const occupied = this.conn && this.connOpen;
      if (occupied && this.acceptPolicy && !this.acceptPolicy()) {
        // 対戦中は先着1名のみ。新規接続は開いたらすぐ閉じる
        c.on('open', () => { try { c.close(); } catch { /* noop */ } });
        return;
      }
      if (this.conn && this.conn !== c) { try { this.conn.close(); } catch { /* noop */ } }
      this._wireConn(c);
    }

    /* ---------- ゲスト ---------- */
    join(code) {
      this.role = 'guest';
      this.code = code;
      this._destroyed = false;
      this._joinAttempts = 0;
      const peer = (this.peer = new this.PeerCtor(undefined, this._peerOpts()));
      peer.on('open', () => this._tryConnect());
      peer.on('disconnected', () => this._reconnectSignaling());
      peer.on('error', (e) => this._onPeerError(e));
    }

    _tryConnect() {
      if (this._destroyed || !this.peer || this.connOpen) return;
      this._joinAttempts++;
      const c = this.peer.connect(peerIdFor(this.code), { reliable: true });
      this._wireConn(c);
      this._clearTimeout(this._connectTimer);
      this._connectTimer = this._setTimeout(() => {
        if (!this.connOpen && !this._destroyed) {
          this._emit('error', {
            type: 'connect-timeout',
            message: '接続がタイムアウトしました。ホストがこの画面を開いたまま待機しているか、電波の良い場所かを確認してください',
          });
        }
      }, this.connectTimeoutMs);
    }

    /* ---------- 共通 ---------- */
    _reconnectSignaling() {
      if (this._destroyed || !this.peer) return;
      this._emit('status', '中継サーバーとの接続が切れたため、再接続しています…');
      try { this.peer.reconnect(); } catch { /* noop */ }
    }

    _onPeerError(e) {
      const type = (e && e.type) || 'unknown';
      if (type === 'peer-unavailable' && this.role === 'guest') {
        if (this._joinAttempts <= this.maxJoinRetries && !this._destroyed) {
          this._emit('status', `部屋を探しています…（再試行 ${this._joinAttempts}）`);
          this._setTimeout(() => this._tryConnect(), this.retryDelayMs);
          return;
        }
        this._emit('error', { type, message: '部屋が見つかりません。コードと、ホストが待機画面を開いたままにしているかを確認してください' });
        return;
      }
      if (type === 'unavailable-id') {
        this._emit('error', { type, message: 'その部屋コードは使用中でした。お手数ですが部屋を作り直してください' });
        return;
      }
      if (type === 'network' || type === 'server-error') {
        this._emit('error', { type, message: '中継サーバーへ接続できませんでした。通信環境を確認して再試行してください' });
        return;
      }
      this._emit('error', { type, message: '接続エラーが発生しました' });
    }

    _wireConn(c) {
      this.conn = c;
      c.on('open', () => {
        this.connOpen = true;
        this._clearTimeout(this._connectTimer);
        this._clearGrace();
        this._emit('open');
      });
      c.on('data', (d) => this._emit('data', d));
      c.on('close', () => this._handleConnDown('close'));
      c.on('error', () => this._handleConnDown('conn-error'));
      const pc = c.peerConnection;
      if (pc && typeof pc.addEventListener === 'function') {
        pc.addEventListener('iceconnectionstatechange', () => {
          const s = pc.iceConnectionState;
          if (s === 'disconnected') this._startGrace();
          else if (s === 'failed' || s === 'closed') this._handleConnDown('ice-' + s);
          else if (s === 'connected' || s === 'completed') this._clearGrace();
        });
      }
    }

    _startGrace() {
      if (this._graceTimer || !this.connOpen || this._destroyed) return;
      this._emit('status', '接続が不安定です。回復を待っています…');
      this._graceTimer = this._setTimeout(
        () => this._handleConnDown('ice-disconnected-timeout'),
        this.disconnectGraceMs
      );
    }

    _clearGrace() {
      if (this._graceTimer) { this._clearTimeout(this._graceTimer); this._graceTimer = null; }
    }

    _handleConnDown(why) {
      if (!this.connOpen) return;
      this.connOpen = false;
      this._clearGrace();
      this._emit('peerLost', { why });
    }

    send(msg) {
      if (this.conn && this.connOpen) { this.conn.send(msg); return true; }
      return false;
    }

    get isOpen() { return this.connOpen; }

    destroy() {
      this._destroyed = true;
      this._clearGrace();
      this._clearTimeout(this._connectTimer);
      try { if (this.conn) this.conn.close(); } catch { /* noop */ }
      try { if (this.peer) this.peer.destroy(); } catch { /* noop */ }
      this.conn = null;
      this.peer = null;
      this.connOpen = false;
    }
  }

  const api = { Net, ICE_SERVERS, peerIdFor, normalizeCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ADNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
