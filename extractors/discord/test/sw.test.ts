/**
 * The extension's service worker (src/extension/sw.js), run on stand-ins for Chromium's runtime and the WebSocket: a
 * command that arrives while no Discord page has connected is refused at once, so the adapter does not wait out its
 * timeout ("hook timed out on reactionContext") on a tab stuck on an error page; with a page, it goes to the page.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SW = readFileSync(join(import.meta.dir, '../src/extension/sw.js'), 'utf8');

function boot() {
  const sent: any[] = [];
  let sock: any = null;
  let onConnect: ((port: any) => void) | null = null;
  class FakeSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      sock = this;
    }
    send(frame: string) {
      sent.push(JSON.parse(frame));
    }
    close() {}
  }
  const chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, onConnect: { addListener: (f: (port: any) => void) => (onConnect = f) } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const fetch = async () => ({ json: async () => ({ wsUrl: 'ws://127.0.0.1:1', token: 't' }) });
  const self = { addEventListener() {} };
  new Function('chrome', 'WebSocket', 'fetch', 'self', 'setTimeout', SW)(chrome, FakeSocket, fetch, self, () => 0);
  const open = async () => {
    for (let i = 0; i < 20 && !sock; i++) await Bun.sleep(1);
    sock.readyState = 1;
    sock.onopen();
  };
  const down = (msg: unknown) => sock.onmessage({ data: JSON.stringify(msg) });
  const page = () => {
    const got: any[] = [];
    onConnect!({ postMessage: (m: unknown) => got.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener() {} } });
    return got;
  };
  return { sent, open, down, page };
}

test('no Discord page connected: a command is refused at once, naming why', async () => {
  const w = boot();
  await w.open();
  w.down({ t: 'cmd', id: 'c1', cmd: { kind: 'reactionContext', channelId: '700000000000000001' } });
  w.down({ t: 'ping' });
  expect(w.sent.filter((m) => m.t === 'reply')).toEqual([{ t: 'reply', id: 'c1', ok: false, error: 'Discord is not open in the sandbox' }]);
});

test('with a Discord page connected, a command goes to the page and is not refused', async () => {
  const w = boot();
  await w.open();
  const got = w.page();
  const cmd = { t: 'cmd', id: 'c2', cmd: { kind: 'reactionContext', channelId: '700000000000000001' } };
  w.down(cmd);
  expect(got).toEqual([cmd]);
  expect(w.sent.filter((m) => m.t === 'reply')).toEqual([]);
});
