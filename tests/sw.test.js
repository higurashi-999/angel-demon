'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

test('Service Worker: キャッシュ名が現行版（v3以降）である', () => {
  const m = sw.match(/const CACHE = 'angel-demon-v(\d+)'/);
  assert.ok(m, 'CACHE 定数が見つかる');
  assert.ok(Number(m[1]) >= 3, `更新を取りこぼさない版数である (v${m[1]})`);
});

test('Service Worker: ネットワーク優先で取得し、失敗時のみキャッシュを使う', () => {
  const fetchIdx = sw.indexOf('fetch(e.request)');
  const matchIdx = sw.indexOf('caches.match');
  assert.ok(fetchIdx !== -1 && matchIdx !== -1);
  assert.ok(fetchIdx < matchIdx, 'fetch が caches.match より前に試される（ネットワーク優先）');
});

test('Service Worker: 必須アセットが全てプリキャッシュ対象に含まれる', () => {
  for (const asset of ['./index.html', './js/game.js', './js/net.js', './js/session.js', './js/cpu.js', './js/fx.js', './js/app.js', './css/style.css']) {
    assert.ok(sw.includes(`'${asset}'`), `${asset} が ASSETS に含まれる`);
  }
});
