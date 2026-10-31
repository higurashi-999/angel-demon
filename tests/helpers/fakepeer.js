'use strict';
/* PeerJS のインメモリ偽物。2つの Net/GameSession をつないでテストするためのブローカー。 */
class FakeConn {
  constructor() {
    this.handlers = {};
    this.closed = false;
    this.peerConnection = {
      iceConnectionState: 'connected',
      _listeners: {},
      addEventListener(ev, fn) { this._listeners[ev] = fn; },
      setIce(state) {
        this.iceConnectionState = state;
        if (this._listeners.iceconnectionstatechange) this._listeners.iceconnectionstatechange();
      },
    };
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, ...args) { (this.handlers[ev] || []).slice().forEach((f) => f(...args)); }
  pair(other) { this.other = other; }
  send(data) {
    if (this.closed || !this.other) return;
    const o = this.other;
    setImmediate(() => { if (!o.closed) o.emit('data', data); });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    const o = this.other;
    setImmediate(() => { this.emit('close'); if (o && !o.closed) { o.closed = true; o.emit('close'); } });
  }
}

class FakePeer {
  static registry = new Map();
  constructor(id, opts) {
    this.id = id || 'fake-' + Math.random().toString(36).slice(2);
    this.handlers = {};
    this.opts = opts;
    if (id) {
      if (FakePeer.registry.has(id)) {
        setImmediate(() => this.emit('error', { type: 'unavailable-id' }));
        return;
      }
      FakePeer.registry.set(id, this);
    }
    setImmediate(() => this.emit('open', this.id));
  }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev, ...args) { (this.handlers[ev] || []).slice().forEach((f) => f(...args)); }
  connect(remoteId) {
    const remote = FakePeer.registry.get(remoteId);
    const c1 = new FakeConn();
    if (!remote) {
      setImmediate(() => this.emit('error', { type: 'peer-unavailable' }));
      return c1;
    }
    const c2 = new FakeConn();
    c1.pair(c2); c2.pair(c1);
    setImmediate(() => {
      remote.emit('connection', c2);
      c1.emit('open');
      c2.emit('open');
    });
    return c1;
  }
  reconnect() { setImmediate(() => this.emit('open', this.id)); }
  destroy() { if (this.id) FakePeer.registry.delete(this.id); }
}

module.exports = { FakePeer, FakeConn };
