/** linkHub's replies: a RefusalError's status goes with the refusal; a plain error stays a bare failure. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkHub, RefusalError } from '../src/adapter-client.ts';

const dir = mkdtempSync(join(tmpdir(), 'chat-client-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('a refusal carries its status to the manager; a failure carries none', async () => {
  const replies = new Map<string, (r: any) => void>();
  let sock: { send(s: string): void } | null = null;
  let opened!: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open(ws) {
        sock = ws;
        opened();
      },
      message(_ws, data) {
        const m = JSON.parse(String(data));
        if (m.t === 'reply') replies.get(m.id)?.(m);
      },
    },
  });
  const env = { DITHER_HUB_URL: `ws://127.0.0.1:${server.port}/`, DITHER_ACCOUNT_ID: 'acct-123', DITHER_ADAPTER_TOKEN: 't', DITHER_ACCOUNT_DIR: dir };
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const hub = linkHub({
    onCommand: (cmd) => {
      if ((cmd as { url?: string }).url === 'missing') throw new RefusalError('no profile picture', 404);
      throw new Error('it broke');
    },
  });
  try {
    await ready;
    const ask = (id: string, url: string) =>
      new Promise<any>((resolve) => {
        replies.set(id, resolve);
        sock!.send(JSON.stringify({ t: 'fetchMedia', id, url }));
      });
    expect(await ask('1', 'missing')).toEqual({ t: 'reply', id: '1', ok: false, error: 'no profile picture', status: 404 });
    expect(await ask('2', 'other')).toEqual({ t: 'reply', id: '2', ok: false, error: 'it broke' });
  } finally {
    hub.close();
    server.stop(true);
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
