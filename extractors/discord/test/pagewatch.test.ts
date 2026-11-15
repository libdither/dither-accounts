/**
 * The Discord tab is reloaded when its page never spoke after the worker attached, or stopped answering (pagewatch.ts),
 * and the service worker answers at once when it has no page to run a command in (sw.js), instead of dropping it.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_WAIT_MS, PAGE_START_MS, PageWatch, SILENT_LIMIT } from '../src/pagewatch.ts';

function clock() {
  let t = 1_000_000;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

test('a page that never speaks after the worker attached is reloaded, then waited for twice as long', () => {
  const c = clock();
  const w = new PageWatch(c.now);
  expect(w.due()).toBeNull(); // no worker, nothing to reload through
  w.attached();
  c.add(PAGE_START_MS - 1);
  expect(w.due()).toBeNull();
  c.add(1);
  expect(w.due()).toContain('has not spoken in 120 s');
  w.reloaded();
  expect(w.due()).toBeNull();
  c.add(PAGE_START_MS);
  expect(w.due()).toBeNull(); // the second wait is twice the first
  c.add(PAGE_START_MS);
  expect(w.due()).toContain('has not spoken');
  for (let i = 0; i < 10; i++) w.reloaded();
  c.add(MAX_WAIT_MS);
  expect(w.due()).not.toBeNull(); // the wait stops growing
});

test('a page that speaks is left alone, and a worker that went away is not reloaded through', () => {
  const c = clock();
  const w = new PageWatch(c.now);
  w.attached();
  c.add(5_000);
  w.heard();
  c.add(60 * 60_000);
  expect(w.due()).toBeNull();
  const d = new PageWatch(c.now);
  d.attached();
  d.detached();
  c.add(PAGE_START_MS * 2);
  expect(d.due()).toBeNull();
});

test('requests left unanswered in a row reload the tab; a word from the page between them resets the count', () => {
  const c = clock();
  const w = new PageWatch(c.now);
  w.attached();
  w.heard();
  for (let i = 1; i < SILENT_LIMIT; i++) w.unanswered();
  w.heard();
  w.unanswered();
  expect(w.due()).toBeNull();
  for (let i = 1; i < SILENT_LIMIT; i++) w.unanswered();
  expect(w.due()).toContain(`did not answer ${SILENT_LIMIT} requests in a row`);
  w.reloaded();
  for (let i = 0; i < SILENT_LIMIT; i++) w.unanswered();
  expect(w.due()).toBeNull(); // not again until the page has had its wait after the reload
  c.add(PAGE_START_MS * 2);
  expect(w.due()).not.toBeNull();
});

/** sw.js run with a stand-in chrome and WebSocket: what it sends up, and what it did to tabs. */
function worker(tabs: { id: number; url: string }[]) {
  const up: any[] = [];
  const did: string[] = [];
  let sock: any = null;
  let onConnect: ((port: any) => void) | null = null;
  class FakeSocket {
    readyState = 1;
    onopen: any;
    onmessage: any;
    onclose: any;
    onerror: any;
    constructor() {
      sock = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(f: string) {
      up.push(JSON.parse(f));
    }
    close() {}
  }
  const chrome = {
    runtime: { getURL: (p: string) => p, onConnect: { addListener: (f: any) => (onConnect = f) } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: {
      query: async (q: { url: string }) => (q.url === 'https://discord.com/*' ? tabs.filter((t) => t.url.startsWith('https://discord.com/')) : tabs),
      update: async (id: number, p: { url: string }) => (did.push(`update ${id} ${p.url}`), { id }),
      create: async (p: { url: string }) => (did.push(`create ${p.url}`), { id: 99 }),
    },
  };
  const self = { addEventListener() {} };
  const fetch = async () => ({ json: async () => ({ wsUrl: 'ws://127.0.0.1:1/', token: 't' }) });
  const src = readFileSync(join(import.meta.dir, '../src/extension/sw.js'), 'utf8');
  new Function('chrome', 'WebSocket', 'self', 'fetch', src)(chrome, FakeSocket, self, fetch);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    up,
    did,
    settle,
    down: (msg: unknown) => sock.onmessage({ data: JSON.stringify(msg) }),
    page: () => {
      const got: any[] = [];
      onConnect!({ postMessage: (m: any) => got.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener() {} } });
      return got;
    },
  };
}

test('the worker answers a command at once when no page is attached, and hands it to the page when one is', async () => {
  const w = worker([]);
  await w.settle();
  w.down({ t: 'cmd', id: 'c1', cmd: { kind: 'reactionContext', channelId: '700000000000000001' } });
  expect(w.up).toContainEqual({ t: 'reply', id: 'c1', ok: false, error: 'the Discord page is not open in the sandbox', from: 'worker' });
  const got = w.page();
  w.down({ t: 'cmd', id: 'c2', cmd: { kind: 'reactionContext', channelId: '700000000000000001' } });
  expect(got).toEqual([{ t: 'cmd', id: 'c2', cmd: { kind: 'reactionContext', channelId: '700000000000000001' } }]);
  expect(w.up.find((m) => m.id === 'c2')).toBeUndefined();
});

test("tab.reload sends the Discord tab back to its start, or opens one when there is none; never another site's", async () => {
  const a = worker([
    { id: 3, url: 'https://example.com/' },
    { id: 7, url: 'https://discord.com/channels/@me' },
  ]);
  await a.settle();
  a.page(); // a page is attached: tab.reload is the worker's own, never handed to it
  a.down({ t: 'cmd', id: 'r1', cmd: { kind: 'tab.reload', url: 'https://discord.com/app' } });
  await a.settle();
  expect(a.did).toEqual(['update 7 https://discord.com/app']);
  expect(a.up).toContainEqual({ t: 'reply', id: 'r1', ok: true, result: { how: 'navigated' }, from: 'worker' });

  const b = worker([]);
  await b.settle();
  b.down({ t: 'cmd', id: 'r2', cmd: { kind: 'tab.reload', url: 'https://evil.example/' } });
  await b.settle();
  expect(b.did).toEqual(['create https://discord.com/app']);
  expect(b.up).toContainEqual({ t: 'reply', id: 'r2', ok: true, result: { how: 'opened' }, from: 'worker' });
});
