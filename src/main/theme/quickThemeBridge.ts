/** Served as an external, parser-blocking script before any theme-authored markup. */
export const QUICK_THEME_BRIDGE_FILE = '__bridge.js'

/**
 * This bridge runs in the UNTRUSTED theme realm. The parent must validate the
 * source window, key, generation and every action; this is not an IPC authority.
 * The generation lives only in the document fragment, never in a resource path.
 */
function bridgeSource(kind: 'quick' | 'settings'): string {
  const label = kind === 'quick' ? 'Quick' : 'Settings'
  return String.raw`(() => {
  'use strict';
  const parentWindow = window.parent;
  const key = location.pathname.split('/')[1];
  const generation = new URLSearchParams(location.hash.slice(1)).get('generation');
  if (parentWindow === window || !/^[a-f0-9]{64}$/.test(key || '') || !/^[A-Za-z0-9_-]{16,160}$/.test(generation || '')) return;
  let port = null;
  let closed = false;
  let readyRequested = false;
  let readySent = false;
  let lastState = null;
  let sequence = 0;
  const stateListeners = new Set();
  const focusListeners = new Set();
  const stateWaiters = new Set();
  const pending = new Map();
  const copy = value => structuredClone(value);
  const send = message => port.postMessage({ ...message, generation });
  const flush = () => {
    if (!port || closed) return;
    if (readyRequested && !readySent) { readySent = true; send({ type: 'ready' }); }
    for (const [id, request] of pending) {
      if (request.sent) continue;
      request.sent = true;
      try { send({ type: 'action', id, action: request.action }); }
      catch { request.finish({ ok: false, error: 'Invalid ${label} action' }); }
    }
  };
  const notify = (listeners, value) => {
    for (const listener of [...listeners]) {
      try { listener(copy(value)); } catch { /* A theme listener does not own the channel. */ }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('message', attach);
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
    for (const request of [...pending.values()]) request.finish({ ok: false, error: '${label} surface closed' });
    for (const waiter of [...stateWaiters]) waiter.fail();
    stateListeners.clear(); focusListeners.clear(); lastState = null;
  };
  const receive = event => {
    const message = event.data;
    if (closed || !message || typeof message !== 'object' || message.generation !== generation) return;
    if (message.type === 'state' && message.state && message.state.version === 1) {
      lastState = copy(message.state);
      for (const waiter of [...stateWaiters]) waiter.finish();
      notify(stateListeners, lastState);
    } else if (message.type === 'focus' && typeof message.selectAll === 'boolean') {
      notify(focusListeners, { selectAll: message.selectAll });
    } else if (message.type === 'action-result' && typeof message.id === 'string') {
      const result = message.result;
      if (result && typeof result.ok === 'boolean') pending.get(message.id)?.finish({
        ok: result.ok, ...(typeof result.error === 'string' ? { error: result.error.slice(0, 512) } : {})
      });
    }
  };
  const attach = event => {
    const message = event.data;
    if (closed || port || event.source !== parentWindow || !message || message.type !== 'enest-${kind}:port' ||
        message.key !== key || message.generation !== generation || event.ports.length !== 1) return;
    port = event.ports[0];
    window.removeEventListener('message', attach);
    port.onmessage = receive;
    port.onmessageerror = close;
    port.start();
    flush();
  };
  const subscribe = (listeners, listener) => {
    if (typeof listener !== 'function') throw new TypeError('Expected a listener');
    if (closed) return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const api = Object.freeze({
    ready() { if (!closed) { readyRequested = true; flush(); } },
    getState() {
      if (closed) return Promise.reject(new Error('${label} surface closed'));
      if (lastState) return Promise.resolve(copy(lastState));
      if (stateWaiters.size >= 64) return Promise.reject(new Error('Too many state requests'));
      return new Promise((resolve, reject) => {
        const waiter = {
          finish() { clearTimeout(timer); stateWaiters.delete(waiter); resolve(copy(lastState)); },
          fail() { clearTimeout(timer); stateWaiters.delete(waiter); reject(new Error('${label} state unavailable')); }
        };
        const timer = setTimeout(() => waiter.fail(), 10000);
        stateWaiters.add(waiter);
      });
    },
    onState(listener) { return subscribe(stateListeners, listener); },
    onFocus(listener) { return subscribe(focusListeners, listener); },
    action(action) {
      if (closed || pending.size >= 64) return Promise.resolve({ ok: false, error: '${label} action unavailable' });
      let value;
      try { value = copy(action); } catch { return Promise.resolve({ ok: false, error: 'Invalid ${label} action' }); }
      return new Promise(resolve => {
        const id = String(++sequence);
        const request = {
          action: value, sent: false,
          finish(result) { clearTimeout(timer); pending.delete(id); resolve(result); }
        };
        // Native settings confirmations settle in the host, not on a competing client deadline.
        const timer = ${kind === 'settings' ? 'null' : `setTimeout(() => request.finish({ ok: false, error: 'Quick action timed out' }), 10000)`};
        pending.set(id, request);
        flush();
      });
    }
  });
  Object.defineProperty(window, 'enest${label}', { value: api, writable: false, configurable: false });
  window.addEventListener('message', attach);
  window.addEventListener('pagehide', close, { once: true });
  parentWindow.postMessage({ type: 'enest-${kind}:connect', key, generation }, '*');
})();`
}

export const QUICK_THEME_BRIDGE_SOURCE = bridgeSource('quick')
export const SETTINGS_THEME_BRIDGE_SOURCE = bridgeSource('settings')
