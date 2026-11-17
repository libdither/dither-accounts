/**
 * src/page/isolated-world.js, the content script's relay between a hook and its service worker, against a stand-in for
 * Chrome's ports on a virtual clock. The stand-in keeps the rules that matter here: a message travels for a moment
 * before it arrives, a message that arrives after its receiving end called disconnect() is dropped without a word, and
 * the other end hears of a disconnect only a moment later. The worker does as every extension's sw.js does: it sends
 * each command to the page's newest port, which it uses only once it has placed it (Google places a port after reading
 * its config).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, '../src/page/isolated-world.js'), 'utf8');
const IPC_MS = 2; // how long a message or a disconnect takes to reach the other end
const PLACE_MS = 20; // how long the worker takes to place a new port
const ROTATE_MS = 250_000;

/** A virtual clock: timers run in order of when they are due, only when the test moves time on. */
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number; seq: number }>();
  const add = (fn: () => void, ms: number, every?: number) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms), fn, every, seq: id });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms = 0) => add(fn, ms),
    setInterval: (fn: () => void, ms: number) => add(fn, ms, ms),
    clear: (id: number) => timers.delete(id),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void; every?: number; seq: number }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[1].seq < next[1].seq))) next = e;
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

type Listener = (m: unknown) => void;
interface End {
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(f: Listener): void };
  onDisconnect: { addListener(f: () => void): void };
}

/** One page's content script and the worker at the other end of its ports. */
function world() {
  const c = clock();
  const toHook: unknown[] = [];
  const worker = { ports: [] as { end: End; placed: boolean }[], fromPage: [] as unknown[] };

  function pair(): [End, End] {
    const ends = [0, 1].map(() => ({ closed: false, msg: [] as Listener[], gone: [] as (() => void)[] }));
    const make = (me: number): End => ({
      postMessage(m) {
        if (ends[me].closed) throw new Error('Attempting to use a disconnected port object');
        const other = ends[1 - me];
        c.setTimeout(() => {
          if (!other.closed) for (const f of other.msg) f(m);
        }, IPC_MS);
      },
      disconnect() {
        if (ends[me].closed) return;
        ends[me].closed = true;
        const other = ends[1 - me];
        c.setTimeout(() => {
          if (other.closed) return;
          other.closed = true;
          for (const f of other.gone) f();
        }, IPC_MS);
      },
      onMessage: { addListener: (f) => ends[me].msg.push(f) },
      onDisconnect: { addListener: (f) => ends[me].gone.push(f) },
    });
    return [make(0), make(1)];
  }

  const chrome = {
    runtime: {
      connect() {
        const [page, sw] = pair();
        // The worker's onConnect: the port is known at once, and placed (usable for commands) a little later.
        c.setTimeout(() => {
          const entry = { end: sw, placed: false };
          worker.ports.push(entry);
          sw.onMessage.addListener((m) => worker.fromPage.push(m));
          sw.onDisconnect.addListener(() => worker.ports.splice(worker.ports.indexOf(entry), 1));
          c.setTimeout(() => (entry.placed = true), PLACE_MS);
        }, IPC_MS);
        return page;
      },
    },
  };

  const listeners = new Map<string, ((e: { detail: unknown }) => void)[]>();
  const window = {
    addEventListener: (type: string, f: (e: { detail: unknown }) => void) => listeners.set(type, [...(listeners.get(type) ?? []), f]),
    dispatchEvent(e: { type: string; detail: unknown }) {
      if (e.type === 'down') toHook.push(e.detail);
      for (const f of listeners.get(e.type) ?? []) f(e);
      return true;
    },
  };
  class CustomEvent {
    constructor(
      readonly type: string,
      init: { detail: unknown },
    ) {
      this.detail = init.detail;
    }
    detail: unknown;
  }

  const run = new Function('window', 'chrome', 'CustomEvent', 'setTimeout', 'setInterval', 'QUEUE', SOURCE.replaceAll('__MARK_up__', 'up').replaceAll('__MARK_down__', 'down'));
  run(window, chrome, CustomEvent, c.setTimeout, c.setInterval, 200);

  /** A command from the worker to the page's newest placed port, as sw.js sends it; false when it has none. */
  const send = (cmd: unknown) => {
    const p = worker.ports.filter((x) => x.placed).at(-1);
    if (!p) return false;
    p.end.postMessage(cmd);
    return true;
  };
  const up = (detail: unknown) => window.dispatchEvent({ type: 'up', detail });
  return { c, toHook, worker, send, up };
}

test('a command the worker sends to the page at any moment of a port swap reaches the hook', () => {
  // Every offset around the swap, 1 ms apart: before it, in the moment the old port closes, while the worker has not
  // yet placed the new one, and after.
  for (let offset = -10; offset <= 40; offset++) {
    const w = world();
    w.c.advance(1000);
    expect(w.worker.ports.length).toBe(1);
    w.c.advance(ROTATE_MS - 1000 + offset);
    expect(w.send({ id: offset })).toBe(true);
    w.c.advance(60_000);
    expect({ offset, got: w.toHook.filter((m) => m !== null) }).toEqual({ offset, got: [{ id: offset }] });
    // The old port is let go: one port is left, and it carries frames both ways.
    expect(w.worker.ports.length).toBe(1);
    w.up({ t: 'reply', id: offset });
    w.c.advance(100);
    expect(w.worker.fromPage).toEqual([{ t: 'reply', id: offset }]);
  }
});

test('the old port closing at its far end does not cut off the new one', () => {
  const w = world();
  w.c.advance(ROTATE_MS + 5);
  expect(w.worker.ports.length).toBe(2);
  // The worker lets the old port go before the page does (it may: a reload of the worker closes every port).
  const old = w.worker.ports.shift()!;
  old.end.disconnect();
  w.c.advance(60_000);
  expect(w.worker.ports.length).toBe(1);
  w.up({ t: 'hook', n: 1 });
  w.c.advance(100);
  expect(w.worker.fromPage).toEqual([{ t: 'hook', n: 1 }]);
  expect(w.send({ id: 'after' })).toBe(true);
  w.c.advance(100);
  expect(w.toHook.filter((m) => m !== null)).toEqual([{ id: 'after' }]);
});
