/**
 * Typing both ways against the local testbed homeserver (testbed/testbed.ts), with the real adapter in a process of
 * its own: your typing reaches another member's /sync as m.typing, and theirs arrives as typing events, stop included.
 *
 *   DITHER_TESTBED_DIR=/tmp/tb DITHER_TESTBED_PORT=6199 bun extractors/matrix/testbed/testbed.ts up
 *   DITHER_TESTBED_DIR=/tmp/tb bun extractors/matrix/test/integration-typing.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { enc } from '../src/http.ts';
import { MATRIX_TYPING_TTL } from '../src/adapter.ts';

const REPO = resolve(import.meta.dir, '../../..');
const tb = JSON.parse(readFileSync(join(process.env.DITHER_TESTBED_DIR ?? join(REPO, '.data/matrix-testbed'), 'testbed.json'), 'utf8'));
const DM: string = tb.rooms.dm;
const quinn = tb.users.quinn.userId as string;
const alice = tb.users.alice as { userId: string; accessToken: string };
const token = crypto.randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-typing-'));
writeFileSync(join(dir, 'secret.json'), JSON.stringify({ userId: quinn, password: tb.users.quinn.password }), { mode: 0o600 });

const events: P.AdapterEvent[] = [];
let ws: import('bun').ServerWebSocket<unknown> | null = null;
const server = Bun.serve<unknown, never>({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/adapter' && u.searchParams.get('token') === token && srv.upgrade(req, { data: {} })) return undefined;
    return new Response('no', { status: 401 });
  },
  websocket: {
    open: (s) => void (ws = s),
    message: (_s, raw) => void events.push(JSON.parse(String(raw))),
  },
});
const proc = Bun.spawn(['bun', join(REPO, 'extractors/matrix/src/main.ts')], {
  cwd: REPO,
  env: { ...process.env, DITHER_HUB_URL: `ws://127.0.0.1:${server.port}/adapter`, DITHER_ACCOUNT_ID: 'acc_typing', DITHER_ADAPTER_TOKEN: token, DITHER_ACCOUNT_DIR: dir, DITHER_ACCOUNT_CONFIG: JSON.stringify({ homeserver: tb.baseUrl }) },
  stdout: 'ignore',
  stderr: 'inherit',
});

let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const until = async <T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 20_000): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(150);
  }
  return null;
};
const cmd = async (c: Record<string, unknown>) => {
  const id = crypto.randomUUID();
  ws!.send(JSON.stringify({ ...c, id }));
  const r = (await until(() => events.find((e) => e.t === 'reply' && e.id === id) as Extract<P.AdapterEvent, { t: 'reply' }> | undefined))!;
  if (!r?.ok) throw new Error(`${c.t}: ${r && 'error' in r ? r.error : 'no reply'}`);
  return r.result;
};
const asAlice = (method: string, path: string, body?: unknown) =>
  fetch(tb.baseUrl + path, { method, headers: { authorization: `Bearer ${alice.accessToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as any);

/** Who alice's /sync says is typing in the DM, from the position she has. */
let since: string | undefined;
const aliceSeesTyping = async (): Promise<string[] | null> => {
  const r = await asAlice('GET', `/_matrix/client/v3/sync?timeout=1000${since ? `&since=${enc(since)}` : ''}&filter=${enc(JSON.stringify({ room: { timeline: { limit: 0 }, state: { lazy_load_members: true } } }))}`);
  since = r.next_batch;
  const ev = r.rooms?.join?.[DM]?.ephemeral?.events?.find((e: any) => e.type === 'm.typing');
  return ev ? ev.content.user_ids : null;
};

try {
  check(await until(() => events.some((e) => e.t === 'status' && e.status === 'online'), 60_000), 'the adapter is online on the testbed');
  await aliceSeesTyping();

  await cmd({ t: 'typing', conversation: DM });
  const seen = await until(async () => {
    const ids = await aliceSeesTyping();
    return ids?.includes(quinn) ? ids : null;
  });
  check(seen, 'your typing reaches the other member as m.typing');
  await cmd({ t: 'typing', conversation: DM, stop: true });
  const gone = await until(async () => {
    const ids = await aliceSeesTyping();
    return ids && !ids.includes(quinn) ? true : null;
  });
  check(gone, 'and the stop takes you off the list');

  const n = events.length;
  await asAlice('PUT', `/_matrix/client/v3/rooms/${enc(DM)}/typing/${enc(alice.userId)}`, { typing: true, timeout: 20_000 });
  const start = (await until(() => events.slice(n).find((e) => e.t === 'typing' && e.author === alice.userId))) as Extract<P.AdapterEvent, { t: 'typing' }> | null;
  check(start && start.conversation === DM && !start.stop && start.ttl === MATRIX_TYPING_TTL, `their typing arrives (${JSON.stringify(start)})`);
  check(!events.slice(n).some((e) => e.t === 'typing' && e.author === quinn), 'never yours');
  await asAlice('PUT', `/_matrix/client/v3/rooms/${enc(DM)}/typing/${enc(alice.userId)}`, { typing: false });
  const stop = await until(() => events.slice(n).find((e) => e.t === 'typing' && e.author === alice.userId && e.stop));
  check(stop, 'and so does their stop');
} finally {
  proc.kill();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
