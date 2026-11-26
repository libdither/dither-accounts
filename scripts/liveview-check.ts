#!/usr/bin/env bun
/**
 * The live view as the manager's page drives it, on each display backend given: noVNC (the repo's own copy, as
 * packages/manager/web's LiveView sets it up) in a headless Chromium, through a WebSocket bridged to a browser sandbox's
 * VNC socket as the manager bridges it. What it checks, on a page that reports what reaches it:
 *   pointer      a click from the viewer's canvas → the page's mousedown (trusted, where it was clicked)
 *   keys         key events into noVNC (a, Shift+B, 1, Enter) → the page's key codes and the field's text
 *   sendText     LiveView's way of typing short text: each character's keysym pressed and released ("xé€ü": Latin-1
 *                keysyms as they are, the rest as 0x01000000 + code point)
 *   clipboard    viewer → sandbox (LiveView's long-text path: clipboardPasteFrom, then Ctrl+V) and sandbox → viewer
 *                (the page copies; noVNC's clipboard event)
 *   resize       noVNC asking for the viewer's size (resizeSession), and, on Wayland, sway's output changing size
 * Temporary directories, port 0, nothing of a manager; prints one JSON line per backend.
 *
 *   bun scripts/liveview-check.ts [--out liveview.json] <backend>...
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBackend, pickFreeDisplay } from '../packages/browser/src/display.ts';
import { resolveChromium, Sandbox } from '../packages/browser/src/sandbox.ts';
import { SwayIpc } from '../packages/browser/src/swayipc.ts';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const BACKENDS = args.map((a) => parseBackend(a) ?? (() => { throw new Error(`no backend "${a}"`); })());
const NOVNC = join(import.meta.dir, '../node_modules/@novnc/novnc');
const root = mkdtempSync(join(tmpdir(), 'liveview-check-'));
process.env.DITHER_DISPLAY_CLAIMS = join(root, 'claims');
mkdirSync(process.env.DITHER_DISPLAY_CLAIMS);

const reports: any[] = [];
let vncSocket = '';
const PROBE = `<html><body style="margin:0">
<input id="f" style="position:absolute;left:100px;top:100px;width:400px;height:40px">
<span id="c" style="position:absolute;left:100px;top:300px">from-page-77 € é 😀</span>
<script>
const f = document.getElementById('f');
const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
let keys = [];
f.addEventListener('mousedown', (e) => say({ ev: 'mousedown', trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
f.addEventListener('keydown', (e) => {
  keys.push(e.code || e.key);
  if (e.code === 'Enter') { say({ ev: 'enter', value: f.value, keys }); keys = []; f.value = ''; }
  if (e.code === 'F2') { const r = document.createRange(); r.selectNodeContents(document.getElementById('c')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); say({ ev: 'copied', ok: document.execCommand('copy') }); f.focus(); }
});
f.addEventListener('paste', (e) => say({ ev: 'paste', text: e.clipboardData.getData('text/plain') }));
const page = () => say({ ev: 'page', w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height });
page(); addEventListener('resize', page);
</script></body></html>`;
const VIEWER = `<html><body style="margin:0"><div id="s" style="width:1280px;height:800px"></div>
<script type="module">
import RFB from '/novnc/core/rfb.js';
window.ev = [];
const rfb = new RFB(document.getElementById('s'), 'ws://' + location.host + '/ws', { wsProtocols: ['binary'] });
rfb.scaleViewport = false; rfb.resizeSession = false; rfb.focusOnClick = true;
rfb.addEventListener('connect', () => { ev.push('connect'); rfb.focus(); });
rfb.addEventListener('disconnect', (e) => ev.push('disconnect:' + e.detail.clean));
rfb.addEventListener('clipboard', (e) => ev.push('clip:' + e.detail.text));
rfb.addEventListener('desktopname', (e) => ev.push('name:' + e.detail.name));
window.rfb = rfb;
</script></body></html>`;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/report') return reports.push(await req.json()), new Response('ok');
    if (u.pathname === '/') return new Response(PROBE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (u.pathname === '/viewer') return new Response(VIEWER, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (u.pathname.startsWith('/novnc/')) {
      const p = join(NOVNC, u.pathname.slice(7));
      if (!p.startsWith(NOVNC) || !existsSync(p)) return new Response('no', { status: 404 });
      return new Response(Bun.file(p), { headers: { 'content-type': 'text/javascript' } });
    }
    if (u.pathname === '/ws') return srv.upgrade(req, { headers: { 'Sec-WebSocket-Protocol': 'binary' } }) ? undefined : new Response('no', { status: 400 });
    return new Response('no', { status: 404 });
  },
  websocket: {
    async open(ws: any) {
      ws.data = { q: [] as Uint8Array[] };
      ws.data.sock = await Bun.connect({
        unix: vncSocket,
        socket: { data: (_s, d) => ws.send(d), close: () => ws.close() },
      });
      for (const b of ws.data.q) ws.data.sock.write(b);
    },
    message(ws: any, m) {
      const b = typeof m === 'string' ? Buffer.from(m) : m;
      if (ws.data.sock) ws.data.sock.write(b);
      else ws.data.q.push(b);
    },
    close(ws: any) { ws.data.sock?.end(); },
  },
});
const origin = `http://127.0.0.1:${server.port}`;

// --- a headless Chromium for the viewer, driven over CDP
const chromiumBin = resolveChromium(() => {});
async function viewerBrowser() {
  const prof = join(root, `viewer-${Date.now()}`);
  mkdirSync(prof);
  const p = Bun.spawn([chromiumBin, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--window-size=1400,900', '--disable-gpu', `${origin}/viewer`], { stdout: 'ignore', stderr: 'ignore' });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(readFileSync(join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await Bun.sleep(100); }
  }
  let target: any;
  for (let i = 0; i < 50 && !target; i++) {
    const ts = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
    target = ts.find((t) => t.type === 'page' && t.url.includes('/viewer'));
    if (!target) await Bun.sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
  const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { p, send, evaluate, close: () => { ws.close(); p.kill(); } };
}

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`no ${what}`); await Bun.sleep(100); }
};
const KEYS: Record<string, [string, string, number]> = { Enter: ['Enter', 'Enter', 13], F2: ['F2', 'F2', 113], Control: ['Control', 'ControlLeft', 17], Shift: ['Shift', 'ShiftLeft', 16] };

const out: Record<string, any> = {};
for (const backend of BACKENDS) {
  const r: any = (out[backend] = {});
  reports.length = 0;
  const acc = join(root, backend);
  const src = join(acc, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0' }));
  const display = await pickFreeDisplay(undefined, [], backend);
  const sb = new Sandbox({ accountDir: acc, display, width: 1280, height: 800, extensionSrc: src, config: {}, startUrl: `${origin}/`, log: () => {} });
  let v: Awaited<ReturnType<typeof viewerBrowser>> | null = null;
  try {
    await sb.start();
    vncSocket = sb.vncSocket;
    await until('page', () => reports.some((x) => x.ev === 'page'), 30000);
    const pg = reports.find((x) => x.ev === 'page');
    const top = 800 - pg.h;
    await Bun.sleep(1500);
    v = await viewerBrowser();
    await until('connect', async () => ((await v!.evaluate('JSON.stringify(window.ev||[])')) ?? '').includes('connect'));
    r.events = JSON.parse(await v.evaluate('JSON.stringify(ev)'));
    const rect = JSON.parse(await v.evaluate("JSON.stringify(document.querySelector('#s canvas').getBoundingClientRect())"));
    r.fb = JSON.parse(await v.evaluate('JSON.stringify([rfb._fbWidth, rfb._fbHeight])'));
    const at = (x: number, y: number) => ({ x: rect.x + x, y: rect.y + y });
    // pointer
    const p = at(250, top + 120);
    await v.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await Bun.sleep(100);
    await v.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await v.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    await until('mousedown', () => reports.some((x) => x.ev === 'mousedown')).catch((e) => (r.pointerError = e.message));
    r.pointer = reports.find((x) => x.ev === 'mousedown');
    // keys from a keyboard into noVNC
    const key = async (k: string, text?: string, mods = 0) => {
      const [kk, code, vk] = KEYS[k] ?? [k, /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : '', k.toUpperCase().charCodeAt(0)];
      await v!.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: kk, code, windowsVirtualKeyCode: vk, text, modifiers: mods });
      await v!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: kk, code, windowsVirtualKeyCode: vk, modifiers: mods });
      await Bun.sleep(40);
    };
    const enter = async (label: string) => {
      const n = reports.filter((x) => x.ev === 'enter').length;
      await key('Enter', '\r');
      await until(`enter (${label})`, () => reports.filter((x) => x.ev === 'enter').length > n).catch((e) => (r[`${label}Error`] = e.message));
      r[label] = reports.filter((x) => x.ev === 'enter')[n];
    };
    await key('a', 'a');
    await v.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
    await key('B', 'B', 8);
    await v.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await key('1', '1');
    await enter('typed');
    // LiveView's sendText: each character's keysym, pressed and released (Latin-1 as is, beyond as 0x01000000 + code point)
    await v.evaluate(`(() => { for (const ch of 'xé€ü') { const cp = ch.codePointAt(0); const sym = cp < 0x100 ? cp : 0x01000000 + cp; rfb.sendKey(sym, '', true); rfb.sendKey(sym, '', false); } })()`);
    await Bun.sleep(500);
    await enter('sendText');
    // clipboard: viewer → sandbox (LiveView's long-text path: clipboardPasteFrom, then Ctrl+V)
    await v.evaluate(`(() => { rfb.clipboardPasteFrom("pasted-123 € é"); setTimeout(() => { rfb.sendKey(0xffe3, 'ControlLeft', true); rfb.sendKey(0x76, 'KeyV', true); rfb.sendKey(0x76, 'KeyV', false); rfb.sendKey(0xffe3, 'ControlLeft', false); }, 150); })()`);
    await until('paste', () => reports.some((x) => x.ev === 'paste'), 5000).catch(() => {});
    r.pasteToSandbox = reports.find((x) => x.ev === 'paste') ?? null;
    await enter('afterPaste');
    // clipboard: sandbox → viewer
    await key('F2');
    await until('copied', () => reports.some((x) => x.ev === 'copied'), 5000).catch(() => {});
    await Bun.sleep(1500);
    r.copyToViewer = JSON.parse(await v.evaluate('JSON.stringify(ev.filter(e => e.startsWith("clip:")))'));
    // resize asked by the viewer (noVNC's resizeSession, the div made smaller)
    await v.evaluate(`(() => { document.getElementById('s').style.width = '1000px'; document.getElementById('s').style.height = '640px'; rfb.resizeSession = true; })()`);
    await Bun.sleep(2500);
    r.afterViewerResize = JSON.parse(await v.evaluate('JSON.stringify([rfb._fbWidth, rfb._fbHeight])'));
    await v.evaluate(`rfb.resizeSession = false`);
    // the compositor changing size (Wayland only): does the viewer follow?
    if (sb.screen && 'ipcSocket' in sb.screen) {
      const ipc = await SwayIpc.connect((sb.screen as { ipcSocket: string }).ipcSocket);
      await ipc.command('output * mode --custom 1024x700');
      await Bun.sleep(2500);
      r.afterServerResize = JSON.parse(await v.evaluate('JSON.stringify([rfb._fbWidth, rfb._fbHeight])'));
      r.stillConnected = !JSON.parse(await v.evaluate('JSON.stringify(ev)')).some((e: string) => e.startsWith('disconnect'));
      ipc.close();
    }
    r.finalEvents = JSON.parse(await v.evaluate('JSON.stringify(ev)'));
  } catch (e) {
    r.error = (e as Error).message;
  } finally {
    v?.close();
    await sb.stop();
  }
  console.log(backend, JSON.stringify(r));
}
server.stop(true);
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
rmSync(root, { recursive: true, force: true });
