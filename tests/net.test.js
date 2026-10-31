'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Net, normalizeCode } = require('../js/net.js');
const { FakePeer } = require('./helpers/fakepeer.js');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const CODE = 'ABCD2345EFGH6789';

function makeNet(extra = {}) {
  return new Net({
    PeerCtor: FakePeer,
    connectTimeoutMs: 300,
    disconnectGraceMs: 60,
    retryDelayMs: 10,
    maxJoinRetries: 2,
    ...extra,
  });
}

test('normalizeCode: 小文字や区切りを正規化する', () => {
  assert.strictEqual(normalizeCode('abcd-2345 efgh'), 'ABCD2345EFGH');
  assert.strictEqual(normalizeCode(''), '');
  assert.strictEqual(normalizeCode(null), '');
});

test('ホストとゲストが接続し、双方向にデータを送れる', async () => {
  FakePeer.registry.clear();
  const host = makeNet();
  const guest = makeNet();
  const got = { host: [], guest: [] };
  host.on('data', (d) => got.host.push(d));
  guest.on('data', (d) => got.guest.push(d));
  host.host(CODE);
  await tick();
  guest.join(CODE);
  await tick(30);
  assert.strictEqual(host.isOpen, true);
  assert.strictEqual(guest.isOpen, true);
  guest.send({ t: 'hello-guest' });
  host.send({ t: 'hello-host' });
  await tick(20);
  assert.deepStrictEqual(got.host, [{ t: 'hello-guest' }]);
  assert.deepStrictEqual(got.guest, [{ t: 'hello-host' }]);
  host.destroy(); guest.destroy();
});

test('存在しない部屋への参加はリトライ後にエラーになる', async () => {
  FakePeer.registry.clear();
  const guest = makeNet();
  let err = null;
  let statuses = 0;
  guest.on('error', (e) => { err = e; });
  guest.on('status', () => { statuses++; });
  guest.join(CODE);
  await tick(200);
  assert.ok(err, 'エラーが通知される');
  assert.strictEqual(err.type, 'peer-unavailable');
  assert.ok(statuses >= 1, '再試行のステータスが出る');
  guest.destroy();
});

test('対戦中は2人目の参加を断り、切断後の再接続は受け入れる', async () => {
  FakePeer.registry.clear();
  const host = makeNet();
  host.acceptPolicy = () => false; // 対戦中を模擬
  host.host(CODE);
  await tick();
  const g1 = makeNet();
  g1.join(CODE);
  await tick(30);
  assert.strictEqual(host.isOpen, true);
  const g2 = makeNet();
  g2.join(CODE);
  await tick(30);
  // 2人目は open 直後に閉じられ、ホストの接続は1人目のまま
  assert.strictEqual(host.conn.other, g1.conn);
  assert.strictEqual(g2.isOpen, false);
  assert.strictEqual(host.isOpen, true);
  // 1人目が切断したら、ポリシーを緩めれば再接続を受け入れる
  g1.conn.close();
  await tick(30);
  assert.strictEqual(host.isOpen, false);
  host.acceptPolicy = () => true;
  const g3 = makeNet();
  g3.join(CODE);
  await tick(30);
  assert.strictEqual(host.isOpen, true);
  assert.strictEqual(g3.isOpen, true);
  host.destroy(); g1.destroy(); g2.destroy(); g3.destroy();
});

test('ICEの一時的な disconnected は猶予内に回復すれば切断扱いしない', async () => {
  FakePeer.registry.clear();
  const host = makeNet();
  const guest = makeNet();
  let lost = 0;
  host.on('peerLost', () => { lost++; });
  host.host(CODE);
  await tick();
  guest.join(CODE);
  await tick(30);
  const pc = host.conn.peerConnection;
  pc.setIce('disconnected');
  await tick(20);
  pc.setIce('connected'); // 猶予(60ms)内に回復
  await tick(100);
  assert.strictEqual(lost, 0);
  assert.strictEqual(host.isOpen, true);
  // 回復しなければ猶予後に切断扱い
  pc.setIce('disconnected');
  await tick(120);
  assert.strictEqual(lost, 1);
  assert.strictEqual(host.isOpen, false);
  host.destroy(); guest.destroy();
});

test('同じコードでの二重ホストは unavailable-id エラーになる', async () => {
  FakePeer.registry.clear();
  const h1 = makeNet();
  h1.host(CODE);
  await tick();
  const h2 = makeNet();
  let err = null;
  h2.on('error', (e) => { err = e; });
  h2.host(CODE);
  await tick(30);
  assert.ok(err);
  assert.strictEqual(err.type, 'unavailable-id');
  h1.destroy(); h2.destroy();
});
