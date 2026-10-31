'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
const { FakePeer } = require('./helpers/fakepeer.js');
const { Net } = require('../js/net.js');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* index.html を読み、スクリプトを実ファイルから順に評価したウィンドウを作る。
 * preset にはスクリプト評価前に行う初期化（sessionStorage の事前設定など）を渡せる */
function makeWindow(url = 'https://example.test/', preset = null) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, 'crypto', { value: webcrypto });
  window.Peer = FakePeer;
  if (preset) preset(window);
  for (const f of ['js/game.js', 'js/net.js', 'js/session.js', 'js/cpu.js', 'js/fx.js', 'js/app.js']) {
    window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
  return dom;
}
const hidden = (dom, id) => dom.window.document.getElementById(id).classList.contains('hidden');

test('初期表示: ロビーが見え、盤が36マス描画される', () => {
  const dom = makeWindow();
  assert.strictEqual(hidden(dom, 'lobby'), false);
  assert.strictEqual(hidden(dom, 'waiting-room'), true);
  assert.strictEqual(hidden(dom, 'game'), true);
  assert.strictEqual(dom.window.document.querySelectorAll('#board .cell').length, 36);
  dom.window.close();
});

test('ホスト: 部屋を作ると待機ルームへ遷移し、ゲスト接続で対戦画面へ進む', async () => {
  FakePeer.registry.clear();
  const dom = makeWindow();
  const { document } = dom.window;
  document.getElementById('btn-create').click();
  await sleep(30);
  // ホスト本人が待機ルームに「入室」した状態になる（今回の修正点）
  assert.strictEqual(hidden(dom, 'waiting-room'), false);
  assert.strictEqual(hidden(dom, 'lobby'), true);
  const code = dom.window.sessionStorage.getItem('adg-host-code');
  assert.strictEqual(code.length, 16);
  assert.match(document.getElementById('wait-code').textContent, /[A-Z0-9]{4} [A-Z0-9]{4}/);
  assert.match(document.getElementById('waiting-status').textContent, /部屋ができました/);
  // ゲストが参加すると自動で対戦画面（配置）へ
  const guest = new Net({ PeerCtor: FakePeer });
  guest.join(code);
  await sleep(60);
  assert.strictEqual(hidden(dom, 'game'), false);
  assert.strictEqual(hidden(dom, 'waiting-room'), true);
  assert.strictEqual(hidden(dom, 'placement-panel'), false);
  guest.destroy();
  dom.window.close();
});

test('ホスト: 再読み込み（タブ復元）でも同じコードで待機が復旧する', async () => {
  FakePeer.registry.clear();
  const CODE = 'REST2345ABCD6789';
  // sessionStorage にホスト情報が残った状態で開き直すと、自動で同じ部屋の待機に戻る
  const dom = makeWindow('https://example.test/', (w) => {
    w.sessionStorage.setItem('adg-host-code', CODE);
  });
  await sleep(30);
  assert.strictEqual(hidden(dom, 'waiting-room'), false);
  assert.strictEqual(hidden(dom, 'lobby'), true);
  assert.ok(FakePeer.registry.has('ad-geister-' + CODE.toLowerCase()), '同じ peer ID でホストが復旧する');
  // 復旧した部屋にもゲストが入れる
  const guest = new Net({ PeerCtor: FakePeer });
  guest.join(CODE);
  await sleep(60);
  assert.strictEqual(hidden(dom, 'game'), false);
  guest.destroy();
  dom.window.close();
});

test('ホスト: 「部屋を閉じる」で待機が解除されロビーに戻る', async () => {
  FakePeer.registry.clear();
  const dom = makeWindow();
  const { document } = dom.window;
  document.getElementById('btn-create').click();
  await sleep(30);
  assert.strictEqual(hidden(dom, 'waiting-room'), false);
  document.getElementById('btn-cancel-room').click();
  await sleep(10);
  assert.strictEqual(hidden(dom, 'waiting-room'), true);
  assert.strictEqual(hidden(dom, 'lobby'), false);
  assert.strictEqual(dom.window.sessionStorage.getItem('adg-host-code'), null);
  dom.window.close();
});

test('招待リンク（?room=）を開くと自動で参加し対戦画面へ進む', async () => {
  FakePeer.registry.clear();
  const CODE = 'WXYZ2345ABCD6789';
  const host = new Net({ PeerCtor: FakePeer });
  host.host(CODE);
  await sleep(20);
  const dom = makeWindow('https://example.test/?room=' + CODE);
  await sleep(80);
  assert.strictEqual(hidden(dom, 'game'), false);
  assert.strictEqual(host.isOpen, true);
  host.destroy();
  dom.window.close();
});

test('CPU対戦: ランダム配置→確定で対戦が始まり、妖精8体と自駒8体が並ぶ', async () => {
  const dom = makeWindow();
  const { document } = dom.window;
  document.getElementById('btn-cpu').click();
  assert.strictEqual(hidden(dom, 'game'), false);
  document.getElementById('btn-random').click();
  assert.strictEqual(document.getElementById('count-angel').textContent, '残り0');
  assert.strictEqual(document.getElementById('count-demon').textContent, '残り0');
  document.getElementById('btn-confirm').click();
  await sleep(900);
  assert.strictEqual(hidden(dom, 'placement-panel'), true);
  const boardText = document.getElementById('board').textContent;
  assert.strictEqual((boardText.match(/🧚/g) || []).length, 8);
  assert.strictEqual((boardText.match(/😇|😈/g) || []).length, 8);
  assert.match(document.getElementById('turn-status').textContent, /手番です/);
  dom.window.close();
});

test('捕獲演出: オーバーレイに天使/悪魔と良し悪しのトーンが表示される', () => {
  const dom = makeWindow();
  const { document } = dom.window;
  dom.window.ADFx.showCaptureFx(document, dom.window.ADFx.captureFxText(true, 'demon'), 50);
  const fx = document.getElementById('capture-fx');
  assert.match(fx.className, /show/);
  assert.match(fx.className, /bad/);
  assert.match(fx.textContent, /悪魔だった/);
  assert.match(fx.textContent, /😈/);
  dom.window.close();
});
