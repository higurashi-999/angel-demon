'use strict';
/*
 * 天使と悪魔 — 捕獲時の演出
 * 「相手の駒を取ったときに天使か悪魔か分かりにくい」への対応。
 * 文言の決定（純粋関数）と、オーバーレイ表示（DOM）を分けてテスト可能にする。
 * 捕獲の意味: 天使を取る=自分の勝利が前進 / 悪魔を取る=相手の「悪魔を取らせる」勝利が前進。
 */
(function (global) {
  function captureFxText(byMe, type) {
    if (byMe && type === 'angel') {
      return { icon: '😇', tone: 'good', title: '相手の天使を捕獲！', sub: '「天使4体捕獲」まで前進しました' };
    }
    if (byMe && type === 'demon') {
      return { icon: '😈', tone: 'bad', title: '相手の悪魔だった…', sub: '相手の「悪魔を取らせる」勝利条件が進んでしまいます' };
    }
    if (!byMe && type === 'angel') {
      return { icon: '😇', tone: 'bad', title: 'あなたの天使が捕獲された', sub: '相手の勝利条件が進みました' };
    }
    return { icon: '😈', tone: 'good', title: 'あなたの悪魔を取らせた！', sub: '「悪魔4体を取らせる」勝利が近づきました' };
  }

  let hideTimer = null;
  /* #capture-fx オーバーレイに大きく表示して自動で消す */
  function showCaptureFx(doc, info, durationMs = 1700) {
    const el = doc.getElementById('capture-fx');
    if (!el) return;
    el.innerHTML =
      `<div class="fx-icon">${info.icon}</div>` +
      `<div class="fx-title">${info.title}</div>` +
      `<div class="fx-sub">${info.sub}</div>`;
    el.className = 'capture-fx show ' + info.tone;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { el.classList.remove('show'); }, durationMs);
  }

  const api = { captureFxText, showCaptureFx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ADFx = api;
})(typeof window !== 'undefined' ? window : globalThis);
