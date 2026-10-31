'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { captureFxText, showCaptureFx } = require('../js/fx.js');

test('捕獲演出の文言: 自分が天使を取る = 良い知らせ', () => {
  const fx = captureFxText(true, 'angel');
  assert.strictEqual(fx.icon, '😇');
  assert.strictEqual(fx.tone, 'good');
  assert.match(fx.title, /天使を捕獲/);
});

test('捕獲演出の文言: 自分が悪魔を取る = 悪い知らせ', () => {
  const fx = captureFxText(true, 'demon');
  assert.strictEqual(fx.icon, '😈');
  assert.strictEqual(fx.tone, 'bad');
  assert.match(fx.title, /悪魔だった/);
});

test('捕獲演出の文言: 自分の天使を取られる = 悪い知らせ', () => {
  const fx = captureFxText(false, 'angel');
  assert.strictEqual(fx.tone, 'bad');
  assert.match(fx.title, /天使が捕獲された/);
});

test('捕獲演出の文言: 自分の悪魔を取らせる = 良い知らせ', () => {
  const fx = captureFxText(false, 'demon');
  assert.strictEqual(fx.tone, 'good');
  assert.match(fx.title, /悪魔を取らせた/);
});

test('showCaptureFx: オーバーレイに内容とトーンが入り、時間後に消える', async () => {
  const el = {
    innerHTML: '',
    className: '',
    classList: { remove(c) { this._removed = c; } },
  };
  const doc = { getElementById: (id) => (id === 'capture-fx' ? el : null) };
  showCaptureFx(doc, captureFxText(true, 'angel'), 20);
  assert.match(el.innerHTML, /😇/);
  assert.match(el.innerHTML, /天使を捕獲/);
  assert.match(el.className, /show/);
  assert.match(el.className, /good/);
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(el.classList._removed, 'show');
});
