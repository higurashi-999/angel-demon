'use strict';
/* 天使と悪魔 — UI / 対戦プロトコル / CPU練習モード
 * 設計の要点（docs/ARCHITECTURE.md）:
 * - 駒の種類は自分の端末だけが保持し、相手には一切送らない（送るのは位置とハッシュのみ）
 * - 配置時に SHA-256 コミットメントを交換し、捕獲・脱出・終局時に開示して検証する
 * - 受信メッセージは全てスキーマ検証＋ルール検証を通してから状態へ適用する
 */
const G = window.Geister;
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
async function commitmentOf(id, type, nonce) {
  return sha256hex(G.commitmentInput(id, type, nonce));
}
function log(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  const ul = $('log');
  ul.prepend(li);
  while (ul.children.length > 30) ul.lastChild.remove();
}
const ICON = { angel: '😇', demon: '😈', fairy: '🧚' };
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
let me = 'A'; // ネット対戦: ホスト=A, ゲスト=B / CPU戦: 人間=A, CPU=B
let peer = null, conn = null, connOpen = false;
let phase = 'lobby'; // lobby|placement|playing|finished
let gameNumber = 0;
let firstPlayer = 'A';

let setupGrid = new Map(); // "x,y" -> 'angel'|'demon'（配置フェーズ用、自分の陣地の絶対座標）
let trayType = 'angel';
let myTypes = {}, myNonces = {}, myCommitments = {}, myPlacements = null;
let oppCommitments = null, oppPlacements = null;
let mySetupSent = false, oppSetupReceived = false;

let state = null; // G.createGame の公開状態
let selectedId = null;
let pendingCapture = null; // {capturedId} 自分が捕獲し、相手の開示待ち
let capturedInfo = {}; // pieceId -> type（公開済みの捕獲結果）
let oppFullReveal = null, verifyDone = false;
let myRematch = false, oppRematch = false;
let invalidMsgCount = 0, revealTimer = null;

/* ---------- 送信（対戦相手エンドポイントへの抽象化） ---------- */
function send(msg) {
  if (mode === 'cpu') {
    setTimeout(() => cpuOnMessage(msg), 250);
  } else if (conn && connOpen) {
    conn.send(msg);
  }
}

/* ---------- メッセージ検証 ---------- */
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
function isIntIn(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }
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
      if (mv.kind === 'move') return mv.to && isIntIn(mv.to.x, 0, 5) && isIntIn(mv.to.y, 0, 5);
      if (mv.kind === 'exit') {
        return m.reveal && G.TYPES.includes(m.reveal.type) && HEX32.test(m.reveal.nonce || '');
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

/* ---------- 対戦相手からのメッセージ ---------- */
async function onOppMessage(m) {
  const opp = G.other(me);
  if (!validateMsg(m, opp)) {
    invalidMsgCount++;
    console.warn('invalid message rejected', invalidMsgCount);
    if (invalidMsgCount > 5 && conn) { log('不正なデータを繰り返し受信したため接続を終了しました'); conn.close(); }
    return;
  }
  switch (m.t) {
    case 'setup': {
      if (oppSetupReceived) return;
      oppSetupReceived = true;
      oppPlacements = m.placements;
      oppCommitments = m.commitments;
      log('相手の配置が確定しました');
      maybeStartGame();
      updatePlacementStatus();
      break;
    }
    case 'move': {
      if (phase !== 'playing' || !state) return;
      const res = G.validateMove(state, opp, m.move);
      if (!res.ok) { console.warn('illegal move rejected:', res.reason); return; }
      if (m.move.kind === 'exit') {
        const expect = oppCommitments[m.move.pieceId];
        const actual = await commitmentOf(m.move.pieceId, m.reveal.type, m.reveal.nonce);
        if (actual !== expect || m.reveal.type !== 'angel') { cheatAbort(); return; }
        capturedInfo[m.move.pieceId] = 'angel';
        G.applyMove(state, m.move);
        G.recordExit(state, opp);
        log('相手の天使が脱出しました');
        finishGame();
        return;
      }
      const { captured } = G.applyMove(state, m.move);
      selectedId = null;
      if (captured) {
        const type = myTypes[captured.id]; // 取られたのは自分の駒なので種類を知っている
        capturedInfo[captured.id] = type;
        log(`相手があなたの${TYPE_JA[type]}${ICON[type]}を捕獲しました`);
        G.recordCapture(state, opp, type);
        send({ t: 'reveal', pieceId: captured.id, type, nonce: myNonces[captured.id] });
        if (state.winner) { finishGame(); return; }
      } else {
        log('相手が駒を動かしました');
      }
      G.endTurn(state);
      afterTurnChange();
      break;
    }
    case 'reveal': {
      if (!pendingCapture || pendingCapture.capturedId !== m.pieceId) return;
      clearTimeout(revealTimer);
      const expect = oppCommitments[m.pieceId];
      const actual = await commitmentOf(m.pieceId, m.type, m.nonce);
      if (actual !== expect) { cheatAbort(); return; }
      capturedInfo[m.pieceId] = m.type;
      log(`相手の${TYPE_JA[m.type]}${ICON[m.type]}を捕獲しました`);
      pendingCapture = null;
      G.recordCapture(state, me, m.type);
      if (state.winner) { finishGame(); return; }
      G.endTurn(state);
      afterTurnChange();
      break;
    }
    case 'fullReveal': {
      oppFullReveal = m;
      verifyOpponent();
      break;
    }
    case 'resign': {
      if (phase === 'playing' && state && !state.winner) {
        state.winner = me; state.winReason = 'resign';
        log('相手が投了しました');
        finishGame();
      }
      break;
    }
    case 'rematch': {
      oppRematch = true;
      if (myRematch) resetGame();
      else $('rematch-status').textContent = '相手が再戦を希望しています。「もう一局」を押してください';
      break;
    }
  }
}

function cheatAbort() {
  if (state) { state.winner = me; state.winReason = 'cheat'; }
  log('相手の開示が配置時のハッシュと一致しませんでした（不正検出）');
  finishGame();
}

/* ---------- ゲーム開始・終了 ---------- */
function maybeStartGame() {
  if (!mySetupSent || !oppSetupReceived || phase !== 'placement') return;
  gameNumber++;
  firstPlayer = gameNumber % 2 === 1 ? 'A' : 'B';
  state = G.createGame({ ...myPlacements, ...oppPlacements }, firstPlayer);
  phase = 'playing';
  selectedId = null; pendingCapture = null; capturedInfo = {};
  oppFullReveal = null; verifyDone = false;
  myRematch = false; oppRematch = false;
  $('placement-panel').classList.add('hidden');
  $('action-bar').classList.remove('hidden');
  $('result-modal').classList.add('hidden');
  log(`第${gameNumber}局開始。先手は${firstPlayer === me ? 'あなた' : '相手'}です`);
  afterTurnChange();
}

function afterTurnChange() {
  render();
  if (mode === 'cpu' && state && !state.winner && state.turn === 'B') {
    setTimeout(cpuTakeTurn, 800);
  }
}

async function verifyOpponent() {
  if (!oppFullReveal || !oppCommitments || verifyDone) return;
  verifyDone = true;
  const opp = G.other(me);
  let ok = true;
  for (let i = 0; i < 8; i++) {
    const id = G.pieceId(opp, i);
    const h = await commitmentOf(id, oppFullReveal.types[id], oppFullReveal.nonces[id]);
    if (h !== oppCommitments[id]) ok = false;
    if (capturedInfo[id] && capturedInfo[id] !== oppFullReveal.types[id]) ok = false;
  }
  const el = $('verify-result');
  el.textContent = ok
    ? '検証OK：相手の配置は事前のハッシュと一致していました'
    : '検証NG：相手の開示が事前のハッシュと一致しません';
  el.className = 'verify ' + (ok ? 'ok' : 'ng');
}

function finishGame() {
  phase = 'finished';
  render();
  const won = state.winner === me;
  $('result-title').textContent = won ? '🎉 勝利！' : '敗北…';
  $('result-detail').textContent = `勝敗の決め手：${REASON_JA[state.winReason] || ''}`;
  $('verify-result').textContent = '相手の配置を検証しています…';
  $('verify-result').className = 'verify';
  $('rematch-status').textContent = '';
  $('result-modal').classList.remove('hidden');
  // 終局時は全駒を開示し、相手にも検証してもらう
  send({ t: 'fullReveal', types: myTypes, nonces: myNonces });
  if (oppFullReveal) verifyOpponent();
  if (mode === 'cpu') cpuOnGameEnd();
}

/* ---------- 自分の手 ---------- */
function myLegalSelected() {
  if (!state || !selectedId) return [];
  return G.legalDestinations(state, selectedId);
}

function doMyMove(move) {
  const res = G.validateMove(state, me, move);
  if (!res.ok) return;
  if (move.kind === 'exit') {
    if (myTypes[move.pieceId] !== 'angel') { log('悪魔は脱出できません'); return; }
    G.applyMove(state, move);
    capturedInfo[move.pieceId] = 'angel';
    send({ t: 'move', move, reveal: { type: 'angel', nonce: myNonces[move.pieceId] } });
    G.recordExit(state, me);
    log('あなたの天使が脱出しました！');
    finishGame();
    return;
  }
  const { captured } = G.applyMove(state, move);
  send({ t: 'move', move });
  selectedId = null;
  if (captured) {
    pendingCapture = { capturedId: captured.id };
    log('相手の駒を捕獲。種類の開示を待っています…');
    if (mode === 'cpu') {
      // CPUは自分の駒の種類を知っているので、少し遅れて開示を返す（ネット対戦の reveal と同じ流れ）
      const cid = captured.id;
      setTimeout(() => {
        onOppMessage({ t: 'reveal', pieceId: cid, type: cpuTypes[cid], nonce: cpuNonces[cid] });
      }, 400);
    }
    revealTimer = setTimeout(() => {
      if (pendingCapture) log('相手から開示が届きません。接続状態を確認してください');
    }, 15000);
    render();
  } else {
    G.endTurn(state);
    afterTurnChange();
  }
}

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
  $('btn-confirm').disabled = !(c.angel === 4 && c.demon === 4) || mySetupSent;
}
function updatePlacementStatus() {
  if (mySetupSent && !oppSetupReceived) $('placement-status').textContent = 'あなたの配置は確定済み。相手の配置を待っています…';
  else if (mySetupSent && oppSetupReceived) $('placement-status').textContent = '対戦を開始します…';
}
function onPlacementCell(x, y) {
  if (mySetupSent) return;
  const key = x + ',' + y;
  if (setupGrid.has(key)) { setupGrid.delete(key); }
  else {
    const c = setupCounts();
    if (trayType === 'angel' && c.angel >= 4) { log('天使は4体までです'); return; }
    if (trayType === 'demon' && c.demon >= 4) { log('悪魔は4体までです'); return; }
    setupGrid.set(key, trayType);
  }
  updateTray();
  renderBoard();
}
async function confirmSetup() {
  const cells = G.placementCells(me);
  const placements = {}, typesArr = [];
  cells.forEach((c, i) => {
    placements[G.pieceId(me, i)] = { x: c.x, y: c.y };
    typesArr.push(setupGrid.get(c.x + ',' + c.y));
  });
  const err = G.validateTypes(typesArr) || G.validatePlacements(me, placements);
  if (err) { log(err); return; }
  myPlacements = placements;
  myTypes = {}; myNonces = {}; myCommitments = {};
  for (let i = 0; i < 8; i++) {
    const id = G.pieceId(me, i);
    myTypes[id] = typesArr[i];
    myNonces[id] = randomHex(16);
    myCommitments[id] = await commitmentOf(id, myTypes[id], myNonces[id]);
  }
  mySetupSent = true;
  updateTray();
  send({ t: 'setup', v: 1, placements: myPlacements, commitments: myCommitments });
  log('配置を確定しました');
  updatePlacementStatus();
  maybeStartGame();
}

/* ---------- 描画 ---------- */
function toView(ax, ay) { return me === 'A' ? { vx: ax, vy: ay } : { vx: 5 - ax, vy: 5 - ay }; }
function toAbs(vx, vy) { return me === 'A' ? { x: vx, y: vy } : { x: 5 - vx, y: 5 - vy }; }

function render() { renderBoard(); renderStatus(); }

function renderStatus() {
  const ts = $('turn-status');
  if (phase === 'placement') ts.textContent = '駒を配置してください';
  else if (phase === 'playing' && state) {
    if (pendingCapture) { ts.textContent = '捕獲の開示待ち…'; ts.className = 'turn-status'; }
    else if (state.turn === me) { ts.textContent = 'あなたの手番です'; ts.className = 'turn-status my-turn'; }
    else { ts.textContent = '相手の手番です'; ts.className = 'turn-status'; }
  } else if (phase === 'finished') ts.textContent = '対戦終了';
  if (state) {
    const mine = state.capturedBy[me], theirs = state.capturedBy[G.other(me)];
    $('score').innerHTML =
      `相手の天使を捕獲 ${mine.angel}/4（あと${4 - mine.angel}）<br>` +
      `自分の悪魔を取らせた ${theirs.demon}/4（あと${4 - theirs.demon}）`;
    const cap = Object.entries(capturedInfo)
      .map(([id, t]) => `<span title="${id}">${ICON[t]}</span>`).join('');
    $('captured').innerHTML = cap ? `公開済み: ${cap}` : '';
  }
  const sel = state && selectedId ? G.getPiece(state, selectedId) : null;
  const canExit = !!(sel && phase === 'playing' && state.turn === me && !pendingCapture &&
    sel.owner === me && myTypes[sel.id] === 'angel' && G.isOnTargetExit(me, sel.x, sel.y));
  $('btn-exit').classList.toggle('hidden', !canExit);
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const hints = phase === 'playing' && state && state.turn === me && !pendingCapture
    ? myLegalSelected() : [];
  for (let vy = 0; vy < 6; vy++) {
    for (let vx = 0; vx < 6; vx++) {
      const { x, y } = toAbs(vx, vy);
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.type = 'button';
      if (G.isPlacementCell(me, x, y)) cell.classList.add('my-zone');
      if (G.isOnTargetExit(me, x, y)) cell.classList.add('exit-target');

      if (phase === 'placement') {
        const t = setupGrid.get(x + ',' + y);
        if (t && G.isPlacementCell(me, x, y)) {
          cell.innerHTML = `<span class="piece ${t}">${ICON[t]}<small>${TYPE_JA[t]}</small></span>`;
        }
        if (G.isPlacementCell(me, x, y)) {
          cell.addEventListener('click', () => onPlacementCell(x, y));
        }
      } else if (state) {
        const p = G.pieceAt(state, x, y);
        if (p) {
          if (p.owner === me) {
            const t = myTypes[p.id];
            cell.innerHTML = `<span class="piece ${t}">${ICON[t]}<small>${TYPE_JA[t]}</small></span>`;
          } else if (mode === 'cpu' && cpuTypes[p.id] && phase === 'finished') {
            const t = cpuTypes[p.id];
            cell.innerHTML = `<span class="piece ${t}">${ICON[t]}<small>${TYPE_JA[t]}</small></span>`;
          } else {
            cell.innerHTML = `<span class="piece fairy">${ICON.fairy}<small>妖精</small></span>`;
          }
          if (p.id === selectedId) cell.classList.add('selected');
        }
        const hint = hints.find((h) => h.x === x && h.y === y);
        if (hint) cell.classList.add('move-hint');
        cell.addEventListener('click', () => onBoardCell(x, y));
      }
      board.appendChild(cell);
    }
  }
}

function onBoardCell(x, y) {
  if (phase !== 'playing' || !state || state.turn !== me || pendingCapture) return;
  const hint = myLegalSelected().find((h) => h.x === x && h.y === y);
  if (selectedId && hint) { doMyMove({ kind: 'move', pieceId: selectedId, to: { x, y } }); return; }
  const p = G.pieceAt(state, x, y);
  selectedId = p && p.owner === me ? p.id : null;
  render();
}

/* ---------- 再戦・投了 ---------- */
function resetGame() {
  setupGrid.clear();
  myTypes = {}; myNonces = {}; myCommitments = {}; myPlacements = null;
  oppCommitments = null; oppPlacements = null;
  mySetupSent = false; oppSetupReceived = false;
  state = null; selectedId = null; pendingCapture = null; capturedInfo = {};
  phase = 'placement';
  $('result-modal').classList.add('hidden');
  $('action-bar').classList.add('hidden');
  $('placement-panel').classList.remove('hidden');
  $('placement-status').textContent = '';
  $('score').innerHTML = ''; $('captured').innerHTML = '';
  updateTray();
  render();
  log('新しい対局の配置をしてください');
}
$('btn-rematch').addEventListener('click', () => {
  myRematch = true;
  send({ t: 'rematch' });
  if (oppRematch) resetGame();
  else $('rematch-status').textContent = '相手の同意を待っています…';
});
$('btn-leave').addEventListener('click', () => { location.href = location.pathname; });
$('btn-resign').addEventListener('click', () => {
  if (phase !== 'playing' || !state || state.winner) return;
  if (!confirm('投了しますか？')) return;
  state.winner = G.other(me); state.winReason = 'resign';
  send({ t: 'resign' });
  finishGame();
});
$('btn-exit').addEventListener('click', () => {
  if (selectedId) doMyMove({ kind: 'exit', pieceId: selectedId });
});

/* ---------- 配置パネルの操作 ---------- */
$('tray-angel').addEventListener('click', () => { trayType = 'angel'; updateTray(); });
$('tray-demon').addEventListener('click', () => { trayType = 'demon'; updateTray(); });
$('btn-clear').addEventListener('click', () => { if (!mySetupSent) { setupGrid.clear(); updateTray(); renderBoard(); } });
$('btn-random').addEventListener('click', () => {
  if (mySetupSent) return;
  const types = ['angel', 'angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'demon'];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  setupGrid.clear();
  G.placementCells(me).forEach((c, i) => setupGrid.set(c.x + ',' + c.y, types[i]));
  updateTray(); renderBoard();
});
$('btn-confirm').addEventListener('click', confirmSetup);

function startGameScreen() {
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('placement-panel').classList.remove('hidden');
  phase = 'placement';
  updateTray();
  render();
}

/* ---------- ネット対戦（PeerJS / WebRTC） ---------- */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genRoomCode() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function peerIdFor(code) { return 'ad-geister-' + code.toLowerCase(); }
const PEER_OPTS = {
  debug: 0,
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] },
};
function lobbyError(msg) {
  const el = $('lobby-status');
  el.textContent = msg;
  el.className = 'status error';
}
function wireConnection(c) {
  conn = c;
  c.on('open', () => {
    connOpen = true;
    $('lobby-status').textContent = '接続しました！配置に進みます';
    log('相手と接続しました');
    startGameScreen();
  });
  c.on('data', (data) => { onOppMessage(data); });
  c.on('close', () => {
    connOpen = false;
    if (phase === 'playing') log('相手との接続が切れました');
    $('turn-status').textContent = '接続が切れました';
  });
  c.on('error', (e) => { console.warn('connection error', e); lobbyError('接続エラーが発生しました'); });
}
$('btn-create').addEventListener('click', () => {
  mode = 'host'; me = 'A';
  const code = genRoomCode();
  $('room-code').textContent = code.replace(/(.{4})/g, '$1 ').trim();
  $('room-info').classList.remove('hidden');
  $('btn-create').disabled = true;
  $('lobby-status').textContent = '部屋を作成しています…';
  peer = new Peer(peerIdFor(code), PEER_OPTS);
  peer.on('open', () => { $('lobby-status').textContent = '部屋ができました。相手の参加を待っています'; });
  peer.on('connection', (c) => {
    if (conn) { c.on('open', () => c.close()); return; } // 参加は先着1名のみ
    wireConnection(c);
  });
  peer.on('error', (e) => {
    console.warn('peer error', e);
    lobbyError(e.type === 'unavailable-id' ? 'コードが重複しました。もう一度お試しください' : 'サーバーへ接続できませんでした');
    $('btn-create').disabled = false;
  });
  $('btn-copy').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    try { await navigator.clipboard.writeText(url); $('host-wait').textContent = '招待リンクをコピーしました'; }
    catch { $('host-wait').textContent = 'コピーできませんでした。コードを直接伝えてください'; }
  };
});
function joinRoom(rawCode) {
  const code = (rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 16) { lobbyError('部屋コードは16文字で入力してください'); return; }
  mode = 'guest'; me = 'B';
  $('lobby-status').textContent = '部屋を探しています…';
  peer = new Peer(undefined, PEER_OPTS);
  peer.on('open', () => {
    const c = peer.connect(peerIdFor(code), { reliable: true });
    wireConnection(c);
  });
  peer.on('error', (e) => {
    console.warn('peer error', e);
    lobbyError(e.type === 'peer-unavailable'
      ? '部屋が見つかりません。コードと、ホストが待機中かを確認してください'
      : '接続できませんでした。電波の良い場所で再試行してください');
  });
}
$('btn-join').addEventListener('click', () => joinRoom($('join-code').value));

/* ---------- CPU練習モード ---------- */
let cpuTypes = {}, cpuNonces = {}, cpuCommitmentsCache = null;
$('btn-cpu').addEventListener('click', () => {
  mode = 'cpu'; me = 'A';
  cpuTypes = {}; cpuNonces = {}; cpuCommitmentsCache = null;
  log('CPU対戦を開始します');
  startGameScreen();
});
async function cpuSetup() {
  const types = ['angel', 'angel', 'angel', 'angel', 'demon', 'demon', 'demon', 'demon'];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  const placements = {}, commitments = {};
  cpuTypes = {}; cpuNonces = {};
  const cells = G.placementCells('B');
  for (let i = 0; i < 8; i++) {
    const id = G.pieceId('B', i);
    placements[id] = cells[i];
    cpuTypes[id] = types[i];
    cpuNonces[id] = randomHex(16);
    commitments[id] = await commitmentOf(id, types[i], cpuNonces[id]);
  }
  cpuCommitmentsCache = commitments;
  onOppMessage({ t: 'setup', v: 1, placements, commitments });
}
function cpuOnMessage(msg) {
  if (msg.t === 'setup') { cpuSetup(); return; }
  if (msg.t === 'rematch') { onOppMessage({ t: 'rematch' }); return; }
  // 'move' は共有している公開状態へ人間側で適用済み。CPU駒が捕獲された場合の開示は
  // doMyMove 側のフックから reveal として届く。'reveal'/'fullReveal'/'resign' も対応不要。
}
function cpuOnGameEnd() {
  // 終局時の検証用にCPUの全駒を開示する
  setTimeout(() => {
    onOppMessage({ t: 'fullReveal', types: { ...cpuTypes }, nonces: { ...cpuNonces } });
  }, 400);
}
function cpuTakeTurn() {
  if (phase !== 'playing' || !state || state.winner || state.turn !== 'B') return;
  const candidates = [];
  for (const p of state.pieces.filter((p) => p.alive && p.owner === 'B')) {
    const type = cpuTypes[p.id];
    if (type === 'angel' && G.isOnTargetExit('B', p.x, p.y)) {
      candidates.push({ score: 1000, move: { kind: 'exit', pieceId: p.id } });
      continue;
    }
    for (const d of G.legalDestinations(state, p.id)) {
      let score = Math.random() * 6;
      if (d.captures) score += 22 + Math.random() * 10; // 種類は知らないので賭けとして均等に評価
      const exits = G.targetExits('B');
      const dist = (x, y) => Math.min(...exits.map((e) => Math.abs(e.x - x) + Math.abs(e.y - y)));
      if (type === 'angel') score += (dist(p.x, p.y) - dist(d.x, d.y)) * 9;
      if (type === 'demon') score += (d.y - p.y) * 3 + (d.captures ? 6 : 0);
      candidates.push({ score, move: { kind: 'move', pieceId: p.id, to: { x: d.x, y: d.y } } });
    }
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates[0].move;
  const msg = { t: 'move', move: chosen };
  if (chosen.kind === 'exit') msg.reveal = { type: 'angel', nonce: cpuNonces[chosen.pieceId] };
  onOppMessage(msg);
}

/* ---------- 初期化 ---------- */
(function init() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    $('join-code').value = room.toUpperCase();
    joinRoom(room);
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  renderBoard();
})();
