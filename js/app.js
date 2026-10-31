'use strict';
/* 天使と悪魔 — UI層（DOM描画・入力・画面遷移）
 * 対戦プロトコルは session.js、接続は net.js、CPU思考は cpu.js、捕獲演出は fx.js。
 * ここはそれらを画面に結び付けることだけを行う。
 */
const G = window.Geister;
const { GameSession } = window.ADSession;
const $ = (id) => document.getElementById(id);

/* ---------- ユーティリティ ---------- */
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function log(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  const ul = $('log');
  ul.prepend(li);
  while (ul.children.length > 30) ul.lastChild.remove();
}
/* 例外や未処理の失敗も診断に残す（無言で止まるのを防ぐ） */
window.addEventListener('error', (e) => { try { diag(`例外: ${e.message || e.type}`); } catch { /* noop */ } });
window.addEventListener('unhandledrejection', (e) => {
  try { diag(`未処理の失敗: ${(e.reason && e.reason.message) || e.reason || ''}`); } catch { /* noop */ }
});
/* 接続診断ログ（繋がらない原因の切り分け用に画面下へ残す） */
function diag(msg) {
  const el = $('diag-log');
  if (!el) return;
  const t = new Date();
  const ts = `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  el.textContent += `[${ts}] ${msg}\n`;
}
/* 確立した経路の種別（直接/中継）を getStats から読み取って診断に残す */
function probeRoute() {
  setTimeout(async () => {
    try {
      const pc = net && net.conn && net.conn.peerConnection;
      if (!pc || typeof pc.getStats !== 'function') return;
      const stats = await pc.getStats();
      let pair = null;
      const byId = {};
      stats.forEach((r) => { byId[r.id] = r; if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated)) pair = r; });
      if (!pair) { diag('経路: 確認できませんでした'); return; }
      const lt = byId[pair.localCandidateId] && byId[pair.localCandidateId].candidateType;
      const rt = byId[pair.remoteCandidateId] && byId[pair.remoteCandidateId].candidateType;
      diag(`経路: 自分=${lt} 相手=${rt}（relay=中継経由 / srflx=変換経由 / host=直接）`);
    } catch { /* 診断は失敗しても本処理に影響させない */ }
  }, 1500);
}
const ICON = { angel: '😇', demon: '😈', fairy: '🧚' };
const iconImg = (type, cls) => (window.ADIcons ? window.ADIcons.iconImg(type, cls) : ICON[type]);
const TYPE_JA = { angel: '天使', demon: '悪魔' };
const REASON_JA = {
  'capture-angels': '相手の天使を4体すべて捕獲',
  'capture-demons': '悪魔を4体すべて取らせた（取った）側の敗北',
  'exit': '天使が脱出',
  'resign': '投了',
  'cheat': '相手の不正が検出されました',
  'disconnect': '相手との接続が切れました',
};

/* ---------- 状態 ---------- */
let mode = null; // 'host' | 'guest' | 'cpu'
let me = 'A';
let net = null;
let session = null; // 自分の GameSession
let cpuSession = null;
let selectedId = null;
let setupGrid = new Map(); // "x,y" -> 'angel'|'demon'
let trayType = 'angel';
const HOST_KEY = 'adg-host-code';

/* ---------- 画面遷移 ---------- */
function showLobby() {
  $('lobby').classList.remove('hidden');
  $('waiting-room').classList.add('hidden');
  $('game').classList.add('hidden');
}
function showWaiting(code) {
  $('lobby').classList.add('hidden');
  $('waiting-room').classList.remove('hidden');
  $('game').classList.add('hidden');
  $('wait-code').textContent = code.replace(/(.{4})/g, '$1 ').trim();
}
function showGame() {
  $('lobby').classList.add('hidden');
  $('waiting-room').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('placement-panel').classList.remove('hidden');
  $('action-bar').classList.add('hidden');
  $('result-modal').classList.add('hidden');
}
function lobbyError(msg) {
  const el = $('lobby-status');
  el.textContent = msg;
  el.className = 'status error';
}
function waitingStatus(msg) { $('waiting-status').textContent = msg; }

/* ---------- セッションのイベント配線 ---------- */
function makeSessionEvents() {
  return {
    onLog: (m) => log(m),
    onGameStart: () => {
      $('placement-panel').classList.add('hidden');
      $('action-bar').classList.remove('hidden');
      $('result-modal').classList.add('hidden');
      selectedId = null;
      render();
    },
    onGameEnd: ({ winReason, won }) => {
      render();
      $('result-title').textContent = won ? '🎉 勝利！' : '敗北…';
      $('result-detail').textContent = `勝敗の決め手：${REASON_JA[winReason] || ''}`;
      $('verify-result').textContent = '相手の配置を検証しています…';
      $('verify-result').className = 'verify';
      $('rematch-status').textContent = '';
      $('result-modal').classList.remove('hidden');
    },
    onVerify: (ok) => {
      const el = $('verify-result');
      el.textContent = ok
        ? '検証OK：相手の配置は事前のハッシュと一致していました'
        : '検証NG：相手の開示が事前のハッシュと一致しません';
      el.className = 'verify ' + (ok ? 'ok' : 'ng');
    },
    onCapture: ({ byMe, type }) => {
      window.ADFx.showCaptureFx(document, window.ADFx.captureFxText(byMe, type));
      render();
    },
    onExit: () => render(),
    onRematchOffer: () => {
      $('rematch-status').textContent = '相手が再戦を希望しています。「もう一局」を押してください';
    },
    onRematchStart: () => {
      setupGrid.clear();
      selectedId = null;
      $('result-modal').classList.add('hidden');
      $('action-bar').classList.add('hidden');
      $('placement-panel').classList.remove('hidden');
      $('placement-status').textContent = '';
      $('score').innerHTML = '';
      $('captured').innerHTML = '';
      updateTray();
      render();
      log('新しい対局の配置をしてください');
    },
    onTurnChange: () => {
      render();
      updatePlacementStatus();
      if (mode === 'cpu' && session && session.phase === 'playing' &&
          session.state && !session.state.winner && session.state.turn === 'B') {
        setTimeout(() => { if (cpuSession) window.ADCpu.takeTurn(cpuSession); }, 800);
      }
    },
  };
}

function newSession(sendFn) {
  return new GameSession({
    me,
    send: sendFn,
    hash: sha256hex,
    randomHex,
    events: makeSessionEvents(),
    closeTransport: () => { if (net) net.destroy(); },
  });
}

/* ---------- ネット対戦 ---------- */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genRoomCode() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function wireNet() {
  net.acceptPolicy = () => !(session && session.phase === 'playing');
  net.on('hostReady', () => { diag('ホスト登録OK（部屋ができました）'); waitingStatus('部屋ができました。相手の参加を待っています'); });
  net.on('status', (text) => {
    diag(`状態: ${text}`);
    if (!$('waiting-room').classList.contains('hidden')) waitingStatus(text);
    else $('lobby-status').textContent = text;
  });
  net.on('error', (err) => {
    diag(`エラー: ${err.type || ''} ${err.message || ''}`);
    if (err.type === 'unavailable-id') {
      // 復旧しようとした部屋が既に使われていた場合は作り直しへ
      sessionStorage.removeItem(HOST_KEY);
      if (net) net.destroy();
      showLobby();
      lobbyError(err.message);
      return;
    }
    if (!$('waiting-room').classList.contains('hidden')) waitingStatus(err.message);
    else lobbyError(err.message);
  });
  net.on('open', () => {
    log('相手と接続しました');
    diag('相手との接続が確立しました');
    probeRoute();
    if (session && session.phase === 'playing') return; // 対戦中の再接続は状態を保持
    session = newSession((m) => net.send(m));
    showGame();
    updateTray();
    render();
  });
  net.on('data', (d) => { if (session) session.onMessage(d); });
  net.on('iceState', (s) => {
    diag(`回線状態: ${s}`);
    if (s === 'failed') {
      log('接続を確立できませんでした（回線同士の相性）');
      if (!$('waiting-room').classList.contains('hidden')) {
        waitingStatus('接続が切れました。電波の良い場所で、部屋を作り直してみてください');
      }
    }
  });
  net.on('peerLost', (info) => {
    diag(`切断を検知: ${(info && info.why) || ''}`);
    log('相手との接続が切れました');
    if (session && session.phase === 'playing') $('turn-status').textContent = '接続が切れました';
    else if (session && session.phase === 'placement') {
      $('turn-status').textContent = '接続が切れました。相手の再接続を待っています…';
    } else if (!$('waiting-room').classList.contains('hidden')) {
      waitingStatus('接続が切れました。相手が再接続するのを待っています…');
    }
  });
}

function startHosting(code) {
  mode = 'host';
  me = 'A';
  sessionStorage.setItem(HOST_KEY, code);
  showWaiting(code);
  waitingStatus('部屋を作成しています…');
  net = new window.ADNet.Net();
  wireNet();
  diag(`ホスト開始 code=${code}`);
  net.host(code).catch((e) => diag(`ホスト処理で例外: ${(e && e.message) || e}`));
}

function joinRoom(rawCode) {
  const code = window.ADNet.normalizeCode(rawCode);
  if (code.length !== 16) { lobbyError('部屋コードは16文字で入力してください'); return; }
  mode = 'guest';
  me = 'B';
  $('lobby-status').textContent = '部屋を探しています…';
  $('lobby-status').className = 'status';
  net = new window.ADNet.Net();
  wireNet();
  diag(`参加開始 code=${code}（入力 ${String(rawCode).length} 文字 → 正規化 ${code.length} 文字）`);
  net.join(code)
    .then(() => diag('参加処理: 接続の準備ができました'))
    .catch((e) => diag(`参加処理で例外: ${(e && e.message) || e}`));
}

$('btn-create').addEventListener('click', () => startHosting(genRoomCode()));
$('btn-join').addEventListener('click', () => joinRoom($('join-code').value));
$('btn-cancel-room').addEventListener('click', () => {
  // 画面切替を最優先し、接続の破棄は後から確実に行う
  // （実ブラウザで destroy 中の同期的処理が画面切替を妨げる事象への対策）
  sessionStorage.removeItem(HOST_KEY);
  showLobby();
  $('lobby-status').textContent = '';
  const n = net;
  net = null;
  session = null;
  setTimeout(() => { try { if (n) n.destroy(); } catch { /* noop */ } }, 0);
  setTimeout(showLobby, 60); // 念のため切替を再適用する
});
$('btn-copy2').addEventListener('click', async () => {
  const code = sessionStorage.getItem(HOST_KEY);
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    waitingStatus('部屋コードをコピーしました。相手に伝えてください');
  } catch {
    waitingStatus('コピーできませんでした。上のコードを直接伝えてください');
  }
});
$('btn-copy-link').addEventListener('click', async () => {
  const code = sessionStorage.getItem(HOST_KEY);
  if (!code) return;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  try {
    await navigator.clipboard.writeText(url);
    waitingStatus('招待リンクをコピーしました。相手が開くとそのまま参加できます');
  } catch {
    waitingStatus('コピーできませんでした。部屋コードを直接伝えてください');
  }
});

/* 対戦をやめてロビーに戻る（配置画面から） */
$('btn-quit-game').addEventListener('click', () => {
  sessionStorage.removeItem(HOST_KEY);
  const n = net;
  net = null;
  session = null;
  cpuSession = null;
  mode = null;
  showLobby();
  $('lobby-status').textContent = '';
  setTimeout(() => { try { if (n) n.destroy(); } catch { /* noop */ } }, 0);
});

/* 他のアプリから戻ってきたとき、シグナリングが切れていたら繋ぎ直す */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && net) net.ensureSignaling();
});

/* ---------- CPU練習モード ---------- */
$('btn-cpu').addEventListener('click', () => {
  mode = 'cpu';
  me = 'A';
  log('CPU対戦を開始します');
  session = newSession((m) => {
    setTimeout(() => {
      if (!cpuSession) return;
      cpuSession.onMessage(m);
      if (m.t === 'setup' && !cpuSession.mySetupSent) {
        cpuSession.confirmSetup(window.ADCpu.randomTypes());
      }
    }, 250);
  });
  cpuSession = new GameSession({
    me: 'B',
    send: (m) => setTimeout(() => { if (session) session.onMessage(m); }, 250),
    hash: sha256hex,
    randomHex,
    events: {
      onRematchOffer: () => cpuSession.requestRematch(),
    },
  });
  showGame();
  updateTray();
  render();
});

/* ---------- 配置フェーズ ---------- */
function setupCounts() {
  let angel = 0, demon = 0;
  for (const t of setupGrid.values()) (t === 'angel' ? angel++ : demon++);
  return { angel, demon };
}
function updateTray() {
  const c = setupCounts();
  $('count-angel').textContent = `残り${4 - c.angel}`;
  $('count-demon').textContent = `残り${4 - c.demon}`;
  $('tray-angel').classList.toggle('selected', trayType === 'angel');
  $('tray-demon').classList.toggle('selected', trayType === 'demon');
  $('btn-confirm').disabled = !(c.angel === 4 && c.demon === 4) || !!(session && session.mySetupSent);
}
function updatePlacementStatus() {
  if (!session) return;
  if (session.mySetupSent && !session.oppSetupReceived) {
    $('placement-status').textContent = 'あなたの配置は確定済み。相手の配置を待っています…';
  } else if (session.mySetupSent && session.oppSetupReceived) {
    $('placement-status').textContent = '対戦を開始します…';
  }
}
function onPlacementCell(x, y) {
  if (!session || session.mySetupSent) return;
  const key = x + ',' + y;
  if (setupGrid.has(key)) setupGrid.delete(key);
  else {
    const c = setupCounts();
    if (trayType === 'angel' && c.angel >= 4) { log('天使は4体までです'); return; }
    if (trayType === 'demon' && c.demon >= 4) { log('悪魔は4体までです'); return; }
    setupGrid.set(key, trayType);
  }
  updateTray();
  renderBoard();
}
$('tray-angel').addEventListener('click', () => { trayType = 'angel'; updateTray(); });
$('tray-demon').addEventListener('click', () => { trayType = 'demon'; updateTray(); });
$('btn-clear').addEventListener('click', () => {
  if (session && !session.mySetupSent) { setupGrid.clear(); updateTray(); renderBoard(); }
});
$('btn-random').addEventListener('click', () => {
  if (!session || session.mySetupSent) return;
  const types = window.ADCpu.randomTypes();
  setupGrid.clear();
  G.placementCells(me).forEach((c, i) => setupGrid.set(c.x + ',' + c.y, types[i]));
  updateTray();
  renderBoard();
});
$('btn-confirm').addEventListener('click', async () => {
  if (!session) return;
  const types = G.placementCells(me).map((c) => setupGrid.get(c.x + ',' + c.y));
  await session.confirmSetup(types);
  updateTray();
  updatePlacementStatus();
});

/* ---------- 描画 ---------- */
function toAbs(vx, vy) { return me === 'A' ? { x: vx, y: vy } : { x: 5 - vx, y: 5 - vy }; }

function render() { renderBoard(); renderStatus(); renderWinLosePanel(); }

/* 勝敗じょうきょうパネル（自分が把握してよい公開情報のみを表示。
   トグルで非表示にすると、実物の対戦のように自分の頭で数えるモードになる） */
const STATUS_VISIBLE_KEY = 'adg-status-visible';
function statusVisible() {
  try { return localStorage.getItem(STATUS_VISIBLE_KEY) !== '0'; } catch { return true; }
}
function applyStatusVisibility() {
  const vis = statusVisible();
  const toggle = $('toggle-status');
  if (toggle) toggle.checked = vis;
  $('status-grid').classList.toggle('hidden', !vis);
  $('status-hidden-note').classList.toggle('hidden', vis);
}
function renderWinLosePanel() {
  const grid = $('status-grid');
  if (!grid || !window.Geister) return;
  const st = session && session.state;
  const zero = { capturedBy: { A: { angel: 0, demon: 0 }, B: { angel: 0, demon: 0 } } };
  const items = G.summarizeFor(st || zero, me);
  grid.innerHTML = items.map((it) => {
    const dots = '●'.repeat(it.count) + '○'.repeat(it.target - it.count);
    const remain = it.target - it.count;
    const tail = it.effect === 'win' ? `あと${remain}で勝ち✨` : `あと${remain}で負け💦`;
    const type = it.key.includes('angel') ? 'angel' : 'demon';
    return `<div class="stat ${it.effect}"><div class="stat-label">${iconImg(type, 'stat-icon')} ${it.label}</div>` +
      `<div class="stat-dots">${dots}</div><div class="stat-tail">${it.count}/${it.target} ・ ${tail}</div></div>`;
  }).join('');
}
$('toggle-status').addEventListener('change', (e) => {
  try { localStorage.setItem(STATUS_VISIBLE_KEY, e.target.checked ? '1' : '0'); } catch { /* noop */ }
  applyStatusVisibility();
});

function renderStatus() {
  if (!session) return;
  const ts = $('turn-status');
  const phase = session.phase;
  const state = session.state;
  if (phase === 'placement') ts.textContent = '駒を配置してください';
  else if (phase === 'playing' && state) {
    if (session.pendingCapture) { ts.textContent = '捕獲の開示待ち…'; ts.className = 'turn-status'; }
    else if (state.turn === me) { ts.textContent = 'あなたの手番です'; ts.className = 'turn-status my-turn'; }
    else { ts.textContent = '相手の手番です'; ts.className = 'turn-status'; }
  } else if (phase === 'finished') ts.textContent = '対戦終了';
  if (state) {
    $('score').innerHTML = '';
    const cap = Object.entries(session.capturedInfo)
      .map(([id, t]) => `<span title="${id}">${iconImg(t, 'cap-icon')}</span>`).join('');
    $('captured').innerHTML = cap ? `公開済み: ${cap}` : '';
  }
  const sel = state && selectedId ? G.getPiece(state, selectedId) : null;
  const canExit = !!(sel && phase === 'playing' && state.turn === me && !session.pendingCapture &&
    sel.owner === me && session.ownTypes()[sel.id] === 'angel' && G.isOnTargetExit(me, sel.x, sel.y));
  $('btn-exit').classList.toggle('hidden', !canExit);
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const state = session ? session.state : null;
  const phase = session ? session.phase : 'placement';
  const hints = phase === 'playing' && state && state.turn === me && !session.pendingCapture && selectedId
    ? G.legalDestinations(state, selectedId) : [];
  for (let vy = 0; vy < 6; vy++) {
    for (let vx = 0; vx < 6; vx++) {
      const { x, y } = toAbs(vx, vy);
      const cell = document.createElement('button');
      cell.className = 'cell';
      if ((vx + vy) % 2 === 1) cell.classList.add('alt');
      cell.type = 'button';
      if (G.isPlacementCell(me, x, y)) cell.classList.add('my-zone');
      if (G.isOnTargetExit(me, x, y)) cell.classList.add('exit-target');

      if (phase === 'placement' || !state) {
        const t = setupGrid.get(x + ',' + y);
        if (t && G.isPlacementCell(me, x, y)) {
          cell.innerHTML = `<span class="piece ${t}">${iconImg(t)}<small>${TYPE_JA[t]}</small></span>`;
        }
        if (G.isPlacementCell(me, x, y)) {
          cell.addEventListener('click', () => onPlacementCell(x, y));
        }
      } else {
        const p = G.pieceAt(state, x, y);
        if (p) {
          if (p.owner === me) {
            const t = session.ownTypes()[p.id];
            cell.innerHTML = `<span class="piece ${t}">${iconImg(t)}<small>${TYPE_JA[t]}</small></span>`;
          } else if (mode === 'cpu' && cpuSession && phase === 'finished') {
            const t = cpuSession.ownTypes()[p.id];
            cell.innerHTML = `<span class="piece ${t}">${iconImg(t)}<small>${TYPE_JA[t]}</small></span>`;
          } else {
            cell.innerHTML = `<span class="piece fairy">${iconImg('fairy')}<small>妖精</small></span>`;
          }
          if (p.id === selectedId) cell.classList.add('selected');
        }
        if (hints.some((h) => h.x === x && h.y === y)) cell.classList.add('move-hint');
        cell.addEventListener('click', () => onBoardCell(x, y));
      }
      board.appendChild(cell);
    }
  }
}

function onBoardCell(x, y) {
  if (!session || session.phase !== 'playing' || !session.state) return;
  const state = session.state;
  if (state.turn !== me || session.pendingCapture) return;
  const hint = selectedId ? G.legalDestinations(state, selectedId).find((h) => h.x === x && h.y === y) : null;
  if (selectedId && hint) {
    const id = selectedId;
    selectedId = null;
    session.doMove({ kind: 'move', pieceId: id, to: { x, y } });
    render();
    return;
  }
  const p = G.pieceAt(state, x, y);
  selectedId = p && p.owner === me ? p.id : null;
  render();
}

/* ---------- 対局中の操作 ---------- */
$('btn-rematch').addEventListener('click', () => {
  if (!session) return;
  session.requestRematch();
  if (session.phase === 'finished') $('rematch-status').textContent = '相手の同意を待っています…';
});
$('btn-leave').addEventListener('click', () => {
  sessionStorage.removeItem(HOST_KEY);
  try { if (net) net.destroy(); } catch { /* noop */ } // 中継サーバー側の接続を即座に解放してから戻る
  location.href = location.pathname;
});
$('btn-resign').addEventListener('click', () => {
  if (!session || session.phase !== 'playing') return;
  if (!confirm('投了しますか？')) return;
  session.resign();
});
$('btn-exit').addEventListener('click', () => {
  if (session && selectedId) {
    session.doMove({ kind: 'exit', pieceId: selectedId });
    selectedId = null;
    render();
  }
});

/* ---------- 初期化 ---------- */
(function init() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    sessionStorage.removeItem(HOST_KEY); // 招待リンクでの参加を優先し、ホスト復旧はしない
    $('join-code').value = room.toUpperCase();
    joinRoom(room);
  } else {
    const saved = sessionStorage.getItem(HOST_KEY);
    if (saved) startHosting(saved); // タブが再読み込みされても同じ部屋で待機を復旧
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  applyStatusVisibility();
  document.querySelectorAll('img[data-icon]').forEach((el) => {
    const t = el.getAttribute('data-icon');
    if (window.ADIcons && window.ADIcons.URIS[t]) { el.src = window.ADIcons.URIS[t]; el.alt = window.ADIcons.LABELS[t]; }
  });
  renderBoard();
})();
