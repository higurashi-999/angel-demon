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
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  /*
   * 静的認証方式の TURN（staticauth.openrelay.metered.ca）向けに、
   * 有効期限つきクレデンシャルを端末内で生成する（coturn 標準方式）。
   * username = 失効時刻(UNIX秒)、credential = Base64(HMAC-SHA1(secret, username))
   */
  async function staticAuthCredentials(secret, ttlSec = 3600, subtle = null) {
    const cryptoObj = subtle || (typeof crypto !== 'undefined' ? crypto.subtle : null);
    if (!cryptoObj) throw new Error('WebCrypto が使えません');
    const username = String(Math.floor(Date.now() / 1000) + ttlSec);
    const key = await cryptoObj.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = await cryptoObj.sign('HMAC', key, new TextEncoder().encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return { username, credential };
  }

  const STATIC_AUTH_SECRET = 'openrelayprojectsecret';
  const STATIC_AUTH_SERVER = {
    urls: [
      'turn:staticauth.openrelay.metered.ca:80',
      'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
      'turn:staticauth.openrelay.metered.ca:443',
      'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
      'turns:staticauth.openrelay.metered.ca:443?transport=tcp',
    ],
  };

  function peerIdFor(code) { return 'ad-geister-' + String(code).toLowerCase(); }
  function normalizeCode(raw) {
    // 全角英数→半角（日本語キーボード入力対策。全角のままだと下の除去で消えてしまう）
    const half = String(raw || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    return half.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  class Net {
    constructor(opts = {}) {
      this.PeerCtor = opts.PeerCtor || global.Peer;
      if (!this.PeerCtor) throw new Error('PeerJS が読み込まれていません');
      this.iceServers = opts.iceServers || ICE_SERVERS;
      this.connectTimeoutMs = opts.connectTimeoutMs != null ? opts.connectTimeoutMs : 20000;
      this.peerOpenTimeoutMs = opts.peerOpenTimeoutMs != null ? opts.peerOpenTimeoutMs : 12000;
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

    /* 静的認証TURNのクレデンシャルを付けた ICE サーバー一覧を作る */
    async _buildPeerOpts() {
      const servers = [...this.iceServers];
      try {
        const creds = await staticAuthCredentials(STATIC_AUTH_SECRET);
        servers.push({ ...STATIC_AUTH_SERVER, ...creds });
      } catch { /* 生成できない環境では静的認証サーバーなしで続行 */ }
      return { debug: 0, config: { iceServers: servers } };
    }

    /* ---------- ホスト ---------- */
    async host(code) {
      this.role = 'host';
      this.code = code;
      this._destroyed = false;
      const opts = await this._buildPeerOpts();
      if (this._destroyed) return;
      const peer = (this.peer = new this.PeerCtor(peerIdFor(code), opts));
      peer.on('open', () => { this._peerOpened = true; this._emit('hostReady', code); });
      peer.on('connection', (c) => this._accept(c));
      peer.on('disconnected', () => this._reconnectSignaling());
      peer.on('error', (e) => this._onPeerError(e));
      this._armPeerOpenWatchdog();
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
    async join(code) {
      this.role = 'guest';
      this.code = code;
      this._destroyed = false;
      this._joinAttempts = 0;
      const opts = await this._buildPeerOpts();
      if (this._destroyed) return;
      const peer = (this.peer = new this.PeerCtor(undefined, opts));
      peer.on('open', () => { this._peerOpened = true; this._tryConnect(); });
      peer.on('disconnected', () => this._reconnectSignaling());
      peer.on('error', (e) => this._onPeerError(e));
      this._armPeerOpenWatchdog();
    }

    /* 中継サーバー（シグナリング）へ一定時間つながらない場合に打ち切る。
       これがないと「部屋を探しています…」が無限に表示され続ける */
    _armPeerOpenWatchdog() {
      this._peerOpened = false;
      this._setTimeout(() => {
        if (this._destroyed || this._peerOpened) return;
        this._emit('error', {
          type: 'signaling-timeout',
          message: '中継サーバーに接続できませんでした。電波の良い場所で、もう一度お試しください',
        });
        this.destroy();
      }, this.peerOpenTimeoutMs);
    }

    /* 画面復帰時などに、シグナリングが切れていたら繋ぎ直す */
    ensureSignaling() {
      if (this._destroyed || !this.peer) return;
      if (this.peer.disconnected) this._reconnectSignaling();
    }

    _tryConnect() {
      if (this._destroyed || !this.peer || this.connOpen) return;
      this._joinAttempts++;
      this._emit('status', `相手への接続を試みています…（${this._joinAttempts}回目）`);
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
      // イベントは「現在の接続」からのものだけを扱う。差し替え済みの古い接続の
      // close/error が届いても、生きている接続を切断扱いにしない（実バグ修正）。
      const isCurrent = () => this.conn === c;
      // ICE状態の監視。peerConnection は交渉開始後に現れることがあるため、
      // 生成時と open 時の両方で取り付けを試みる（診断の取りこぼし防止）。
      const attachIce = () => {
        const pc = c.peerConnection;
        if (!pc || typeof pc.addEventListener !== 'function' || c._iceWired) return;
        c._iceWired = true;
        pc.addEventListener('iceconnectionstatechange', () => {
          if (!isCurrent()) return;
          const s = pc.iceConnectionState;
          this._emit('iceState', s);
          if (s === 'disconnected') this._startGrace();
          else if (s === 'failed' || s === 'closed') this._handleConnDown('ice-' + s);
          else if (s === 'connected' || s === 'completed') this._clearGrace();
        });
      };
      attachIce();
      c.on('open', () => {
        attachIce();
        if (!isCurrent()) return;
        this.connOpen = true;
        this._clearTimeout(this._connectTimer);
        this._clearGrace();
        this._emit('open');
      });
      c.on('data', (d) => { if (isCurrent()) this._emit('data', d); });
      c.on('close', () => { if (isCurrent()) this._handleConnDown('close'); });
      c.on('error', () => { if (isCurrent()) this._handleConnDown('conn-error'); });
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
      // 破棄処理中の例外が呼び出し側（画面切替など）を止めないよう全体を囲む
      try {
        this._destroyed = true;
        this._clearGrace();
        this._clearTimeout(this._connectTimer);
        try { if (this.conn) this.conn.close(); } catch { /* noop */ }
        try { if (this.peer) this.peer.destroy(); } catch { /* noop */ }
      } catch { /* noop */ } finally {
        this.conn = null;
        this.peer = null;
        this.connOpen = false;
      }
    }
  }

  const api = { Net, ICE_SERVERS, peerIdFor, normalizeCode, staticAuthCredentials };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ADNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
