/**
 * A request the page never answers, told apart in the log (src/silence.ts): the bridge's own diagnosis with a stand-in
 * extension on a WebSocket, and the shared extension parts (page/command-watch.js, page/worker-watch.js) run on
 * stand-in windows and a stand-in chrome.tabs. No browser.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeServer, type Reached } from '../src/bridge.ts';
import { diagnoseSilence, pathTemplate } from '../src/silence.ts';

type Line = { level: string; msg: string; data?: any };
const PAGE = join(import.meta.dir, '../src/page');
const bridges: BridgeServer[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const b of bridges.splice(0)) b.stop();
});

/** A bridge on a free port, and a stand-in extension that answers frames with `answer`. */
async function rig(silence: ConstructorParameters<typeof BridgeServer>[0]['silence'], answer: (frame: any, send: (f: unknown) => void) => void) {
  const lines: Line[] = [];
  const bridge = new BridgeServer({ token: 'tok', onMessage: () => {}, log: (level, msg, data) => lines.push({ level, msg, data }), silence });
  bridges.push(bridge);
  bridge.start();
  const ws = new WebSocket(`${bridge.wsUrl}?token=tok`);
  sockets.push(ws);
  const send = (f: unknown) => ws.send(JSON.stringify(f));
  ws.onmessage = (e) => answer(JSON.parse(String(e.data)), send);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  for (let i = 0; i < 50 && !bridge.connected; i++) await Bun.sleep(10);
  return { bridge, lines, send };
}
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await Bun.sleep(10);
  }
  throw new Error('timed out');
};
const silences = (lines: Line[]) => lines.filter((l) => l.msg.includes("page's silence"));

test("a timed-out request: how far it got, the tab's state and the hook's, in one line", async () => {
  const { bridge, lines } = await rig({ name: 'Mail', tab: true, page: true }, (f, send) => {
    if (f.t !== 'cmd') return;
    if (f.cmd.kind === 'ok') return send({ t: 'reply', id: f.id, ok: true, result: 1 });
    if (f.cmd.kind === 'tab.state') return send({ t: 'reply', id: f.id, ok: true, result: { tabId: 7, status: 'complete', discarded: false, url: 'https://mail.example.com/u/0/inbox/1234567890?q=secret' } });
    if (f.cmd.kind === 'page.state') return send({ t: 'reply', id: f.id, ok: true, result: { visibility: 'visible', open: [{ what: 'api GET mail/v4/messages/*', ms: 900 }] } });
    // The work itself: handed on by the worker, received by the page, never answered.
    send({ t: 'got', id: f.id, at: 'worker' });
    send({ t: 'got', id: f.id, at: 'page' });
  });
  await bridge.request({ kind: 'ok' });
  expect(bridge.lastAnswerAt).not.toBeNull();
  const e = (await bridge.request({ kind: 'api', path: 'mail/v4/messages/abc', body: 'never logged' }, 150).catch((x) => x)) as Error & { reached: Reached };
  expect(e.reached).toBe('page');
  await until(() => silences(lines).length === 1);
  const [line] = silences(lines);
  expect(line!.level).toBe('warn');
  expect(line!.msg).toBe("the Mail page's silence: request received by the page, which never answered; the hook answers without the network");
  expect(line!.data).toMatchObject({ request: 'api', reached: 'received by the page, which never answered', tab: { tabId: 7, status: 'complete', discarded: false }, hook: { visibility: 'visible' } });
  expect(typeof line!.data.lastAnswerAgoS).toBe('number');
  // Command names only: no body, no ids, no query.
  const text = JSON.stringify(line);
  expect(text).not.toContain('never logged');
  expect(text).not.toContain('abc');
  expect(text).not.toContain('1234567890');
  expect(text).not.toContain('secret');
  expect(line!.data.tab.url).toBe('https://mail.example.com/u/*/inbox/*');
});

test('requests that time out together are one diagnosis; probes are never diagnosed themselves', async () => {
  const { bridge, lines } = await rig({ name: 'Discord', tab: true, page: true }, () => {});
  const all = await Promise.allSettled([bridge.request({ kind: 'a' }, 100), bridge.request({ kind: 'b' }, 100)]);
  expect(all.every((r) => r.status === 'rejected' && (r.reason as any).reached === 'none')).toBe(true);
  // Neither the worker nor the hook answers its probe either (5 s each).
  await until(() => silences(lines).length === 1, 8000);
  const [line] = silences(lines);
  expect(line!.msg).toBe("the Discord page's silence: request not acknowledged by the service worker; the hook does not answer either");
  expect(line!.data.tab).toMatch(/^no answer: hook timed out on tab\.state/);
  expect(line!.data.lastAnswerAgoS).toBeNull();
  await Bun.sleep(100);
  expect(silences(lines)).toHaveLength(1);
}, 15_000);

test("a kind whose extension has no probes still gets the bare line: how far, and how long since the last answer", async () => {
  const asked: string[] = [];
  const { bridge, lines } = await rig({ name: 'site', workerRuns: true }, (f, send) => {
    asked.push(f.cmd?.kind);
    if (f.cmd?.kind === 'tab.exec') send({ t: 'got', id: f.id, at: 'worker' });
  });
  await bridge.request({ kind: 'tab.exec', tabId: 3 }, 100).catch(() => {});
  await until(() => silences(lines).length === 1);
  expect(asked).toEqual(['tab.exec']);
  expect(silences(lines)[0]).toMatchObject({ msg: "the site page's silence: request taken by the service worker, which never answered", data: { request: 'tab.exec', lastAnswerAgoS: null } });
});

test('without the option, a timeout is not diagnosed; diagnoseSilence can be called by hand', async () => {
  const { bridge, lines } = await rig(undefined, (f, send) => {
    if (f.cmd?.kind === 'tab.state') send({ t: 'reply', id: f.id, ok: true, result: { tabId: f.cmd.tabId } });
  });
  const e = (await bridge.request({ kind: 'x' }, 100).catch((x) => x)) as Error & { reached: Reached };
  await Bun.sleep(100);
  expect(silences(lines)).toHaveLength(0);
  await diagnoseSilence(bridge, { name: 'Calendar', request: 'x', reached: e.reached, log: (level, msg, data) => lines.push({ level, msg, data }), tab: { kind: 'tab.state', tabId: 4 }, lastAnswerAt: Date.now() - 61_000, extra: { hookUpAgoS: 5 } });
  expect(silences(lines)[0]).toMatchObject({ msg: "the Calendar page's silence: request not acknowledged by the service worker", data: { tab: { tabId: 4 }, lastAnswerAgoS: 61, hookUpAgoS: 5 } });
});

test('pathTemplate: segments with digits, or long ones, as *', () => {
  expect(pathTemplate('/channels/700000000000000001/700000000000000002')).toBe('/channels/*/*');
  expect(pathTemplate('/u/0/r/week')).toBe('/u/*/r/week');
  expect(pathTemplate('/api/mail/v4/messages/' + 'A'.repeat(40))).toBe('/api/mail/*/messages/*');
});

/** command-watch.js as a hook has it: in a function, on a stand-in window. */
function hookWatch(win: any) {
  const src = readFileSync(join(PAGE, 'command-watch.js'), 'utf8');
  return new Function('window', `${src}\nreturn { commandWatch, watchPath };`)(win) as { commandWatch: (o: any) => any; watchPath: (p: string) => string };
}
function standIn() {
  const win: any = new EventTarget();
  const doc: any = new EventTarget();
  doc.visibilityState = 'visible';
  doc.hasFocus = () => true;
  win.document = doc;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  return { win, doc };
}

test("command-watch: the page's got, its page.state, and a command still open", async () => {
  const { win, doc } = standIn();
  const posted: any[] = [];
  const logs: any[] = [];
  const { commandWatch, watchPath } = hookWatch(win);
  const watch = commandWatch({ post: (p: any) => posted.push(p), log: (level: string, msg: string, data: unknown) => logs.push({ level, msg, data }), name: (c: any) => `api ${watchPath(c.path)}`, slowMs: 50 });
  const done = watch.take({ t: 'cmd', id: 'c1', cmd: { kind: 'api', path: '/messages/12345', body: 'x' } });
  expect(posted).toEqual([{ t: 'got', id: 'c1', at: 'page' }]);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('error'));
  await Bun.sleep(80);
  expect(logs.find((l) => l.msg === 'api /messages/* still open after 0.05 s')).toMatchObject({ level: 'warn', data: { visibility: 'hidden' } });
  expect(watch.take({ t: 'cmd', id: 'c2', cmd: { kind: 'page.state' } })).toBeNull();
  const reply = posted.find((p) => p.t === 'reply' && p.id === 'c2');
  expect(reply.result).toMatchObject({ visibility: 'hidden', focused: true, errors: 1, open: [{ what: 'api /messages/*' }], events: [{ name: 'hidden' }] });
  done();
  expect(watch.state().open).toEqual([]);
  // A hook with a page.state of its own answers it itself.
  const own = hookWatch(standIn().win).commandWatch({ post: () => {}, log: () => {}, ownState: true });
  expect(typeof own.take({ t: 'cmd', id: 'c3', cmd: { kind: 'page.state' } })).toBe('function');
});

test("worker-watch: the worker's got, and tab.state from chrome.tabs with the address as a template", async () => {
  const src = readFileSync(join(PAGE, 'worker-watch.js'), 'utf8');
  const chrome = { tabs: { get: async (id: number) => (id === 9 ? { id: 9, url: 'https://discord.example.com/channels/700000000000000001/7?x=1', status: 'loading', active: true, discarded: false, frozen: true } : Promise.reject(new Error('no tab'))) } };
  const ww = new Function('chrome', `${src}\nreturn workerWatch;`)(chrome);
  const sent: any[] = [];
  ww.got((f: unknown) => sent.push(f), 'c1');
  await ww.answer((f: unknown) => sent.push(f), 'c2', 9, { ports: 2 });
  await ww.answer((f: unknown) => sent.push(f), 'c3', 10);
  expect(sent).toEqual([
    { t: 'got', id: 'c1', at: 'worker' },
    { t: 'reply', id: 'c2', ok: true, from: 'worker', result: { tabId: 9, url: 'https://discord.example.com/channels/*/*', status: 'loading', active: true, discarded: false, frozen: true, audible: false, ports: 2 } },
    { t: 'reply', id: 'c3', ok: true, from: 'worker', result: { tabId: 10, gone: true } },
  ]);
});
