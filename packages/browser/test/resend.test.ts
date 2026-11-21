/**
 * The bridge's command ids and its resend (src/bridge.ts): ids carry the bridge's own random part, and a command its
 * page has not said it has is sent again, the same id, after RESEND_MS, up to RESEND_MAX times; never one the page
 * has, one the service worker runs itself, or one the kind says not to. A stand-in extension on a WebSocket; the
 * bridge's timers are Bun's fake ones, so "after 3 s" is a step of the clock, not a wait. Whether a frame was sent is
 * read in order: each test ends with a marker command, and nothing sent before it can arrive after it.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { BridgeServer, type BridgeResend, RESEND_MAX, RESEND_MS } from '../src/bridge.ts';

type Frame = { t: string; id: string; cmd: { kind: string; [k: string]: unknown } };
const bridges: BridgeServer[] = [];
const sockets: WebSocket[] = [];
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  for (const s of sockets.splice(0)) s.close();
  for (const b of bridges.splice(0)) b.stop();
});

/** A bridge and a stand-in extension that keeps every command frame it gets, and wakes whoever waits for one. */
async function rig(resend?: BridgeResend) {
  const lines: string[] = [];
  const marks: string[] = [];
  const bridge = new BridgeServer({ token: 'tok', onMessage: (m) => marks.push(String((m as { id?: unknown }).id)), log: (_l, msg) => lines.push(msg), resend });
  bridges.push(bridge);
  bridge.start();
  const ws = new WebSocket(`${bridge.wsUrl}?token=tok`);
  sockets.push(ws);
  const frames: Frame[] = [];
  let wake: (() => void) | null = null;
  ws.onmessage = (e) => {
    frames.push(JSON.parse(String(e.data)));
    wake?.();
  };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  // The server side's open: its first frame down (a ping) arrives once it has the socket.
  while (!bridge.connected) await new Promise<void>((r) => setImmediate(r));
  const send = (f: unknown) => ws.send(JSON.stringify(f));
  /** The next frame for a command of this kind, the `n`th of them (1: the first). */
  const nth = async (kind: string, n: number) => {
    for (;;) {
      const got = frames.filter((f) => f.cmd?.kind === kind);
      if (got.length >= n) return got[n - 1]!;
      await new Promise<void>((r) => (wake = r));
    }
  };
  /** Frames up to now are all in: a marker command sent after them has arrived. */
  const settled = async () => {
    const p = bridge.request({ kind: 'marker' }, 60_000).catch(() => {});
    const f = await nth('marker', frames.filter((x) => x.cmd?.kind === 'marker').length + 1);
    send({ t: 'reply', id: f.id, ok: true });
    await p;
  };
  /** A frame up (a `got`) has been taken: a message sent after it has reached onMessage. */
  const heard = async (id: string) => {
    send({ t: 'heard', id });
    while (!marks.includes(id)) await new Promise<void>((r) => setImmediate(r));
  };
  const count = (kind: string) => frames.filter((f) => f.cmd?.kind === kind).length;
  return { bridge, frames, send, nth, settled, heard, count, lines };
}

test("ids are the bridge's own: a random part per bridge, then a count", async () => {
  const a = await rig();
  const b = await rig();
  expect(a.bridge.boot).not.toBe(b.bridge.boot);
  expect(a.bridge.boot).toMatch(/^[A-Za-z0-9_-]{8}$/);
  void a.bridge.request({ kind: 'x' }).catch(() => {});
  void b.bridge.request({ kind: 'x' }).catch(() => {});
  const fa = await a.nth('x', 1);
  const fb = await b.nth('x', 1);
  expect(fa.id).toBe(`${a.bridge.boot}.c1`);
  expect(fb.id).toBe(`${b.bridge.boot}.c1`);
  expect(fa.id).not.toBe(fb.id);
});

test('a command its page never said it has is sent again after RESEND_MS, the same id, and answered then', async () => {
  const r = await rig({ kinds: ['work'] });
  const answer = r.bridge.request<number>({ kind: 'work' }, 25_000);
  const first = await r.nth('work', 1);
  // The worker handed it on, and then nothing: lost in the page's port.
  r.send({ t: 'got', id: first.id, at: 'worker' });
  await r.heard('h1');
  jest.advanceTimersByTime(RESEND_MS - 1);
  await r.settled();
  expect(r.count('work')).toBe(1);
  jest.advanceTimersByTime(1);
  const again = await r.nth('work', 2);
  expect(again.id).toBe(first.id);
  expect(again.cmd).toEqual(first.cmd);
  r.send({ t: 'got', id: again.id, at: 'page' });
  r.send({ t: 'reply', id: again.id, ok: true, result: 7 });
  expect(await answer).toBe(7);
  expect(r.lines).toContain('work: no word from the page in 3 s (the worker handed it on); sent again (1)');
});

test('at most RESEND_MAX times; the timeout still comes when nothing answers', async () => {
  const r = await rig({ kinds: ['work'] });
  const answer = r.bridge.request({ kind: 'work' }, 25_000).then(
    () => null,
    (e: Error & { resent?: number }) => e,
  );
  await r.nth('work', 1);
  for (let i = 0; i < RESEND_MAX + 2; i++) jest.advanceTimersByTime(RESEND_MS);
  await r.settled();
  expect(r.count('work')).toBe(1 + RESEND_MAX);
  jest.advanceTimersByTime(25_000);
  const e = await answer;
  expect(e?.message).toBe('hook timed out on work');
  expect(e?.resent).toBe(RESEND_MAX);
});

test('one its page has is not sent again: the page is working on it', async () => {
  const r = await rig({ kinds: ['work'] });
  const answer = r.bridge.request({ kind: 'work' }, 25_000).catch(() => {});
  const f = await r.nth('work', 1);
  r.send({ t: 'got', id: f.id, at: 'page' });
  await r.heard('h1');
  jest.advanceTimersByTime(RESEND_MS * 3);
  await r.settled();
  expect(r.count('work')).toBe(1);
  r.send({ t: 'reply', id: f.id, ok: true });
  await answer;
});

test('only the kinds listed, of those only what `when` lets through, never a tab.*, and nothing without the option', async () => {
  const r = await rig({ kinds: ['read', 'api', 'tab.state'], when: (c) => c.kind !== 'api' || (c as { method?: string }).method === 'GET' });
  const sent = [
    { kind: 'read' },
    { kind: 'api', method: 'GET' },
    { kind: 'api', method: 'POST' },
    { kind: 'send' },
    { kind: 'tab.state' },
    { kind: 'mediaFetch' },
  ];
  for (const c of sent) void r.bridge.request(c, 25_000).catch(() => {});
  for (const c of sent) await r.nth(c.kind, c.kind === 'api' ? 2 : 1);
  jest.advanceTimersByTime(RESEND_MS);
  await r.settled();
  // Sent again: the read and the GET; not the POST, the send, the tab command (listed or not) or the worker's own.
  expect(['read', 'api', 'send', 'tab.state', 'mediaFetch'].map((k) => [k, r.count(k)])).toEqual([
    ['read', 2],
    ['api', 3],
    ['send', 1],
    ['tab.state', 1],
    ['mediaFetch', 1],
  ]);
  const again = r.frames.filter((f) => f.cmd?.kind === 'api').slice(2);
  expect(again.map((f) => f.cmd.method)).toEqual(['GET']);

  const off = await rig();
  void off.bridge.request({ kind: 'work' }, 25_000).catch(() => {});
  await off.nth('work', 1);
  jest.advanceTimersByTime(RESEND_MS * 3);
  await off.settled();
  expect(off.count('work')).toBe(1);
});
