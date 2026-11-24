#!/usr/bin/env bun
/**
 * The two display backends side by side (docs/browser.md, "Display backends"): the same browser sandbox, the same
 * pages, the same input, on x11 (Xvfb, x11vnc, xdotool, import) and on wayland (sway, wayvnc, RFB input, grim), and
 * the numbers as JSON.
 *
 *   bun scripts/bench-display.ts [--out results.json] [--reps 3] [--scale 1,5,10,20] [--only start,idle,...]
 *                                [--max-load <load1>] [--wait-load-s 600]
 *
 * What it measures, each on both backends, `reps` times (alternating which backend goes first), median and spread:
 *   start     sandbox start → the live view answers RFB, and → the first page's script ran
 *   idle      CPU (% of one core) and memory (RSS and PSS) of every process of the sandbox, on a still page
 *   vnc       a viewer of our own on the live view's socket, asking for every frame: delivered frames/s, bytes/s,
 *             the encodings the server used, the VNC server's CPU, during a full-screen animation, a page scrolling
 *             and a video playing; on wayland again from a second wayvnc at 60 frames a second (the sandbox's holds
 *             itself to 30), and one with its GPU features for Open H.264
 *   input     an RFB pointer press → the page's pointerdown (event time and handler time), and → the changed pixels
 *             arriving in the viewer's framebuffer (click to photon)
 *   typing    the backend's own typing (xdotool / RFB keys) of 200 characters: characters per second until the page has
 *             them all
 *   share     in a sandbox of its own with screenShare on: getDisplayMedia of the screen sent over WebRTC to a second
 *             page (packages/browser/test/share-page.ts): frames/s, size, latency, CPU of every process (X's own
 *             capturer vs PipeWire and the portal). The other sandboxes have it off, as every account but Discord.
 *   video     a 1280×720 VP9 video playing in Chromium: dropped and total frames (getVideoPlaybackQuality), CPU
 *   webgl     a full-screen WebGL shader: frames/s
 *   shot      the backend's screenshot (import / grim): ms each
 *   scale     1, 5, 10, 20 sandboxes at once: start time, idle CPU, PSS
 *
 * Every number comes with the machine's load average when it was taken. The machine this was written on is shared
 * and often busy: before each repetition it waits (up to --wait-load-s) for the 1-minute load to fall under
 * --max-load (default: half the cores), and a repetition taken anyway is marked busy. Temporary directories and
 * ports only; nothing of a live manager is touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { resolveBin } from '../packages/browser/src/bins.ts';
import { type FreeDisplay, pickFreeDisplay } from '../packages/browser/src/display.ts';
import { Sandbox } from '../packages/browser/src/sandbox.ts';
import { sharePage, type ShareStats } from '../packages/browser/test/share-page.ts';

// ------------------------------------------------------------------------------------------------ options

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const OUT = arg('out', join(homedir(), '.cache/da-bench', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const REPS = Number(arg('reps', '3'));
const SCALE = arg('scale', '1,5,10,20').split(',').map(Number).filter(Boolean);
const ONLY = new Set(arg('only', 'start,idle,vnc,input,typing,share,video,webgl,shot,scale').split(','));
const MAX_LOAD = Number(arg('max-load', String(cpus().length / 2)));
const WAIT_LOAD_S = Number(arg('wait-load-s', '600'));
const W = 1280;
const H = 800;
const BACKENDS = ['x11', 'wayland'] as const;
type Backend = (typeof BACKENDS)[number];
const HZ = 100; // clock ticks per second in /proc/<pid>/stat (USER_HZ)

const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);
const work = mkdtempSync(join(tmpdir(), 'da-bench-'));

// ------------------------------------------------------------------------------------------------ processes

interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  ticks: number;
}
function procs(): Map<number, Proc> {
  const out = new Map<number, Proc>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = st.lastIndexOf(')');
      const f = st.slice(close + 2).split(' ');
      out.set(Number(d), { pid: Number(d), ppid: Number(f[1]), comm: st.slice(st.indexOf('(') + 1, close), ticks: Number(f[11]) + Number(f[12]) });
    } catch {}
  }
  return out;
}
/** The roots and everything under them. */
function tree(roots: number[], all = procs()): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of all.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const walk = (pid: number) => {
    const p = all.get(pid);
    if (p) out.push(p);
    for (const k of kids.get(pid) ?? []) walk(k.pid);
  };
  for (const r of roots) walk(r);
  return out;
}
/** The program's name without nix's wrapper marks (.wayvnc-wrapped → wayvnc). */
const progName = (p: Proc) => p.comm.replace(/^\./, '').replace(/-wrapped$/, '').replace(/-wrapp?e?$/, '');
function memory(ps: Proc[]): { rssMB: number; pssMB: number } {
  let rss = 0;
  let pss = 0;
  for (const p of ps) {
    try {
      const t = readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8');
      rss += Number(/^Rss:\s+(\d+)/m.exec(t)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(t)?.[1] ?? 0);
    } catch {}
  }
  return { rssMB: rss / 1024, pssMB: pss / 1024 };
}
/** CPU of a set of processes over a span: % of one core, in all and by program name. */
async function cpuOver(roots: () => number[], ms: number): Promise<{ total: number; byName: Record<string, number> }> {
  const before = new Map(tree(roots()).map((p) => [p.pid, p]));
  const t0 = performance.now();
  await Bun.sleep(ms);
  const after = tree(roots());
  const secs = (performance.now() - t0) / 1000;
  const byName: Record<string, number> = {};
  let total = 0;
  for (const p of after) {
    const d = p.ticks - (before.get(p.pid)?.ticks ?? 0);
    const pct = (d / HZ / secs) * 100;
    total += pct;
    const name = progName(p);
    byName[name] = (byName[name] ?? 0) + pct;
  }
  return { total, byName };
}
/** CPU while `f` runs. */
async function cpuDuring<T>(roots: () => number[], f: () => Promise<T>): Promise<{ result: T; cpu: number; byName: Record<string, number> }> {
  const before = new Map(tree(roots()).map((p) => [p.pid, p]));
  const t0 = performance.now();
  const result = await f();
  const after = tree(roots());
  const secs = (performance.now() - t0) / 1000;
  const byName: Record<string, number> = {};
  let cpu = 0;
  for (const p of after) {
    const pct = ((p.ticks - (before.get(p.pid)?.ticks ?? 0)) / HZ / secs) * 100;
    cpu += pct;
    const name = progName(p);
    byName[name] = (byName[name] ?? 0) + pct;
  }
  return { result, cpu, byName };
}

// ------------------------------------------------------------------------------------------------ load

const load1 = () => loadavg()[0]!;
async function quiet(): Promise<{ load: number; busy: boolean; waitedS: number }> {
  const t0 = Date.now();
  while (load1() > MAX_LOAD && Date.now() - t0 < WAIT_LOAD_S * 1000) {
    log(`load ${load1().toFixed(1)} > ${MAX_LOAD}: waiting`);
    await Bun.sleep(15_000);
  }
  return { load: load1(), busy: load1() > MAX_LOAD, waitedS: Math.round((Date.now() - t0) / 1000) };
}

// ------------------------------------------------------------------------------------------------ pages

const ffmpeg = (() => {
  try {
    return resolveBin({ name: 'ffmpeg', env: 'FFMPEG_BIN', nix: 'ffmpeg-headless' }, () => {});
  } catch {
    return null;
  }
})();
const VIDEO = join(homedir(), '.cache/da-bench/video-720p30-vp9.webm');
if (ONLY.has('video') && !existsSync(VIDEO) && ffmpeg) {
  mkdirSync(dirname(VIDEO), { recursive: true });
  log('making the test video');
  const p = Bun.spawnSync([ffmpeg, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', VIDEO]);
  if (p.exitCode !== 0) log('ffmpeg failed', p.stderr.toString().slice(0, 300));
}

/** Every page: reports to /report, and goes where /cmd says (the bench steers the browser this way, no automation). */
const STEER = `<script>
// In a block of its own: the share page has a \`say\` of its own.
{
const report = (o) => fetch('/report', { method: 'POST', body: JSON.stringify({ ...o, page: location.pathname, at: performance.timeOrigin + performance.now() }) });
const seq = Number(new URLSearchParams(location.search).get('s') || 0);
setInterval(async () => { try { const c = await (await fetch('/cmd')).json(); if (c.seq > seq) location.href = c.go + (c.go.includes('?') ? '&' : '?') + 's=' + c.seq; } catch {} }, 100);
addEventListener('load', () => report({ ev: 'page', w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height }));
}
const say = (o) => fetch('/report', { method: 'POST', body: JSON.stringify({ ...o, page: location.pathname, at: performance.timeOrigin + performance.now() }) });
</script>`;

const PAGES: Record<string, string> = {
  '/idle': `<!doctype html><html><body style="margin:0;background:#202124;color:#ddd;font:16px sans-serif"><p style="padding:20px">idle</p>${STEER}</body></html>`,
  '/anim': `<!doctype html><html><body style="margin:0;overflow:hidden;background:#000"><canvas id=c></canvas>${STEER}<script>
const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight; const g = c.getContext('2d');
let n = 0, t0 = 0;
function f(t) { if (!t0) t0 = t; n++; for (let y = 0; y < c.height; y += 32) for (let x = 0; x < c.width; x += 32) { g.fillStyle = 'hsl(' + ((x + y + n * 7) % 360) + ',80%,' + (30 + ((x * 7 + y * 3 + n * 13) % 40)) + '%)'; g.fillRect(x, y, 32, 32); }
  if (t - t0 > 5000) { say({ ev: 'fps', fps: (n - 1) / ((t - t0) / 1000) }); n = 0; t0 = t; } requestAnimationFrame(f); }
requestAnimationFrame(f);
</script></body></html>`,
  '/scroll': `<!doctype html><html><body style="margin:0;font:18px sans-serif">${Array.from({ length: 600 }, (_, i) => `<div style="height:48px;padding:8px 16px;background:hsl(${(i * 37) % 360},40%,${i % 2 ? 85 : 92}%)">Row ${i}: the quick brown fox jumps over the lazy dog, ${'lorem ipsum '.repeat(4)}</div>`).join('')}${STEER}<script>
let n = 0, t0 = 0, dir = 1;
function f(t) { if (!t0) t0 = t; n++; window.scrollBy(0, 12 * dir); if (scrollY + innerHeight >= document.body.scrollHeight - 2) dir = -1; if (scrollY <= 0) dir = 1;
  if (t - t0 > 5000) { say({ ev: 'fps', fps: (n - 1) / ((t - t0) / 1000) }); n = 0; t0 = t; } requestAnimationFrame(f); }
requestAnimationFrame(f);
</script></body></html>`,
  '/input': `<!doctype html><html><body style="margin:0;background:#000;height:100vh">${STEER}<script>
let on = false;
addEventListener('pointerdown', (e) => { on = !on; document.body.style.background = on ? '#fff' : '#000'; say({ ev: 'down', eventAt: performance.timeOrigin + e.timeStamp, handlerAt: performance.timeOrigin + performance.now(), on }); });
</script></body></html>`,
  '/type': `<!doctype html><html><body style="margin:0"><input id=f autofocus style="position:absolute;left:20px;top:20px;width:900px;height:40px;font-size:18px">${STEER}<script>
const f = document.getElementById('f'); f.focus();
f.addEventListener('input', () => { if (f.value.length % 50 === 0 || f.value.length >= 200) say({ ev: 'typed', n: f.value.length }); });
</script></body></html>`,
  '/video': `<!doctype html><html><body style="margin:0;background:#000"><video id=v src="/video.webm" muted autoplay loop playsinline style="width:100vw;height:100vh"></video>${STEER}<script>
const v = document.getElementById('v');
v.addEventListener('playing', () => { const q0 = v.getVideoPlaybackQuality(); setTimeout(() => { const q = v.getVideoPlaybackQuality(); say({ ev: 'video', total: q.totalVideoFrames - q0.totalVideoFrames, dropped: q.droppedVideoFrames - q0.droppedVideoFrames, w: v.videoWidth, h: v.videoHeight }); }, 10000); }, { once: true });
</script></body></html>`,
  '/webgl': `<!doctype html><html><body style="margin:0;overflow:hidden"><canvas id=c></canvas>${STEER}<script>
const c = document.getElementById('c'); c.width = innerWidth; c.height = innerHeight;
const gl = c.getContext('webgl');
const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){gl_Position=vec4(a,0,1);}'));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'precision highp float; uniform float t; uniform vec2 r; void main(){ vec2 u = gl_FragCoord.xy / r; float v = 0.0; for (int i = 0; i < 24; i++) { float fi = float(i); v += sin(u.x * (10.0 + fi) + t * (1.0 + fi * 0.1)) * cos(u.y * (12.0 + fi) - t); } gl_FragColor = vec4(0.5 + 0.5 * sin(v), 0.5 + 0.5 * cos(v * 1.3), 0.5 + 0.5 * sin(v * 0.7 + t), 1.0); }'));
gl.linkProgram(p); gl.useProgram(p);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
const a = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
const ut = gl.getUniformLocation(p, 't'), ur = gl.getUniformLocation(p, 'r');
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
let n = 0, t0 = 0;
function f(t) { if (!t0) t0 = t; n++; gl.uniform1f(ut, t / 1000); gl.uniform2f(ur, c.width, c.height); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (t - t0 > 5000) { say({ ev: 'fps', fps: (n - 1) / ((t - t0) / 1000), renderer }); n = 0; t0 = t; } requestAnimationFrame(f); }
requestAnimationFrame(f);
</script></body></html>`,
  // At the end of the page (its script writes a '</body>' of the receiver's own before that).
  '/share': sharePage({ measureMs: 5000 }).replace(/<\/body><\/html>$/, `${STEER.replace(/\nconst say = .*\n/, '\n')}</body></html>`),
};

// ------------------------------------------------------------------------------------------------ one sandbox

class Bench {
  sb!: Sandbox;
  reports: any[] = [];
  private seq = 0;
  private go = '/idle';
  server: ReturnType<typeof Bun.serve>;
  dir: string;

  constructor(
    readonly backend: Backend,
    readonly flags: string[] = [],
    /** Its own PipeWire and portal (screenShare); off as for every account but Discord, which shares screens. */
    readonly screenShare = false,
  ) {
    this.dir = mkdtempSync(join(work, `${backend}-`));
    const self = this;
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/report') {
          self.reports.push({ ...(await req.json()), got: Date.now() });
          return new Response('ok');
        }
        if (u.pathname === '/cmd') return Response.json({ seq: self.seq, go: self.go });
        if (u.pathname === '/video.webm') return new Response(Bun.file(VIDEO), { headers: { 'content-type': 'video/webm' } });
        const page = PAGES[u.pathname];
        return page ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('no', { status: 404 });
      },
    });
  }

  get origin() {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** The sandbox's own processes (and, through tree(), everything under them). */
  roots = (): number[] => ((this.sb as any)?.procs ?? []).map((p: { proc: { pid: number } }) => p.proc.pid);

  async start(display?: FreeDisplay): Promise<{ screenMs: number; pageMs: number }> {
    const src = join(this.dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'bench', version: '1.0.0' }));
    const free = display ?? (await pickFreeDisplay(undefined, [], this.backend));
    this.sb = new Sandbox({ accountDir: join(this.dir, 'acc'), display: free, width: W, height: H, extensionSrc: src, config: {}, startUrl: `${this.origin}/idle`, screenShare: this.screenShare, flags: this.flags, log: () => {} });
    const t0 = performance.now();
    await this.sb.start();
    const screenMs = performance.now() - t0;
    await this.until('the first page', (r) => r.ev === 'page', 120_000);
    return { screenMs, pageMs: performance.now() - t0 };
  }

  /** Go to a page and wait for it to say it loaded. */
  async open(path: string) {
    this.reports = [];
    this.go = path;
    this.seq++;
    await this.until(path, (r) => r.ev === 'page' && r.page === path, 60_000);
  }

  async until(what: string, ok: (r: any) => boolean, ms = 30_000): Promise<any> {
    const end = Date.now() + ms;
    for (;;) {
      const r = this.reports.find(ok);
      if (r) return r;
      if (Date.now() > end) throw new Error(`${this.backend}: no ${what} within ${ms} ms`);
      await Bun.sleep(25);
    }
  }

  async stop() {
    await this.sb?.stop().catch(() => {});
    this.server.stop(true);
  }

  get vncSocket() {
    return this.sb.vncSocket;
  }
}

// ------------------------------------------------------------------------------------------------ a viewer

const ENC = { raw: 0, copyRect: 1, zrle: 16, tight: 7, h264: 50, desktopSize: -223, lastRect: -224 } as const;
const ENC_NAME: Record<number, string> = { 0: 'raw', 1: 'copyrect', 16: 'zrle', 7: 'tight', 50: 'open-h264', [-223]: 'desktop-size', [-224]: 'last-rect' };

/** A viewer: asks for every frame (incremental), counts them and their bytes, and keeps the picture when raw. */
class Viewer {
  private sock: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private wait: (() => void) | null = null;
  private closed = false;
  width = 0;
  height = 0;
  updates = 0;
  bytes = 0;
  encodings: Record<string, number> = {};
  fb: Uint8Array | null = null;
  /** Called after each whole update. */
  onUpdate: (() => void) | null = null;

  private constructor(path: string) {
    this.sock = connect(path);
    this.sock.on('data', (d: Buffer) => {
      this.bytes += d.length;
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      const w = this.wait;
      this.wait = null;
      w?.();
    });
    this.sock.on('close', () => {
      this.closed = true;
      this.wait?.();
    });
    this.sock.on('error', () => {});
  }

  private async need(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.closed) throw new Error('the server closed the connection');
      await new Promise<void>((r) => (this.wait = r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  static async open(path: string, encodings: number[], keepPicture: boolean): Promise<Viewer> {
    const v = new Viewer(path);
    await v.need(12);
    v.sock.write('RFB 003.008\n');
    const n = (await v.need(1))[0]!;
    await v.need(n);
    v.sock.write(Buffer.from([1]));
    await v.need(4);
    v.sock.write(Buffer.from([1]));
    const init = await v.need(24);
    v.width = init.readUInt16BE(0);
    v.height = init.readUInt16BE(2);
    await v.need(init.readUInt32BE(20));
    // 32 bpp, depth 24, little endian, true colour, 255 each, R at 16, G at 8, B at 0.
    const pf = Buffer.alloc(20);
    pf[0] = 0;
    pf[4] = 32;
    pf[5] = 24;
    pf[6] = 0;
    pf[7] = 1;
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf[14] = 16;
    pf[15] = 8;
    pf[16] = 0;
    v.sock.write(pf);
    const se = Buffer.alloc(4 + 4 * encodings.length);
    se[0] = 2;
    se.writeUInt16BE(encodings.length, 2);
    encodings.forEach((e, i) => se.writeInt32BE(e, 4 + 4 * i));
    v.sock.write(se);
    if (keepPicture) v.fb = new Uint8Array(v.width * v.height * 4);
    v.bytes = 0;
    void v.loop();
    return v;
  }

  private request(incremental: boolean) {
    const r = Buffer.alloc(10);
    r[0] = 3;
    r[1] = incremental ? 1 : 0;
    r.writeUInt16BE(this.width, 6);
    r.writeUInt16BE(this.height, 8);
    this.sock.write(r);
  }

  private async loop() {
    this.request(false);
    try {
      for (;;) {
        const type = (await this.need(1))[0];
        if (type === 0) {
          const h = await this.need(3);
          let rects = h.readUInt16BE(1);
          // Ask for the next one at once: the server sends as fast as it has changes.
          this.request(true);
          while (rects-- > 0) {
            const r = await this.need(12);
            const [x, y, w, hh, enc] = [r.readUInt16BE(0), r.readUInt16BE(2), r.readUInt16BE(4), r.readUInt16BE(6), r.readInt32BE(8)];
            const name = ENC_NAME[enc] ?? String(enc);
            this.encodings[name] = (this.encodings[name] ?? 0) + 1;
            if (enc === ENC.raw) {
              const px = await this.need(w * hh * 4);
              if (this.fb) for (let row = 0; row < hh; row++) this.fb.set(px.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
            } else if (enc === ENC.copyRect) await this.need(4);
            else if (enc === ENC.zrle) await this.need((await this.need(4)).readUInt32BE(0));
            else if (enc === ENC.h264) {
              const l = (await this.need(8)).readUInt32BE(0);
              await this.need(l);
            } else if (enc === ENC.desktopSize) {
              this.width = w;
              this.height = hh;
            } else if (enc === ENC.lastRect) break;
            else throw new Error(`the server used encoding ${enc}, which this viewer does not read`);
          }
          this.updates++;
          this.onUpdate?.();
        } else if (type === 1) {
          const h = await this.need(5);
          await this.need(h.readUInt16BE(3) * 6);
        } else if (type === 2) {
          // bell
        } else if (type === 3) {
          await this.need(3);
          await this.need((await this.need(4)).readUInt32BE(0));
        } else throw new Error(`server message ${type}`);
      }
    } catch {
      /* closed */
    }
  }

  /** The pixel's RGB from the kept picture. */
  pixel(x: number, y: number): [number, number, number] {
    const o = (y * this.width + x) * 4;
    return [this.fb![o + 2]!, this.fb![o + 1]!, this.fb![o]!];
  }

  pointer(x: number, y: number, mask: number) {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this.sock.write(b);
  }

  close() {
    this.sock.destroy();
  }
}

// ------------------------------------------------------------------------------------------------ the measurements

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
const summary = (a: number[]) => ({ median: median(a), p10: q(a, 0.1), p90: q(a, 0.9), min: Math.min(...a), max: Math.max(...a), n: a.length });

async function vnc(b: Bench, page: '/anim' | '/scroll' | '/video', encodings: number[], socket = b.vncSocket, server?: () => number[]) {
  await b.open(page);
  await Bun.sleep(1500);
  const v = await Viewer.open(socket, encodings, false);
  await Bun.sleep(1000);
  const [u0, by0] = [v.updates, v.bytes];
  v.encodings = {};
  const serverName = b.backend === 'x11' ? 'x11vnc' : 'wayvnc';
  const vncPid = server ?? (() => tree(b.roots()).filter((p) => progName(p) === serverName).map((p) => p.pid));
  const t0 = performance.now();
  const cpu = await cpuOver(vncPid, 5000);
  const secs = (performance.now() - t0) / 1000;
  const out = { fps: (v.updates - u0) / secs, bytesPerS: (v.bytes - by0) / secs, encodings: v.encodings, serverCpu: cpu.total, pageFps: b.reports.filter((r) => r.ev === 'fps').pop()?.fps ?? null };
  v.close();
  return out;
}

/**
 * A second wayvnc on the same compositor, on a socket of its own, with other settings than the sandbox's: -f 60 (wayvnc
 * holds itself to 30 frames a second unless told otherwise), or -g for Open H.264, which needs its GPU features (a
 * render node, VA-API encoding through FFmpeg) that the sandbox's own wayvnc does not turn on.
 */
async function otherWayvnc(b: Bench, args: string[], encodings: number[]) {
  const screen = b.sb.screen as unknown as { dir: string; socket: string };
  const tag = `bench-${Math.random().toString(36).slice(2, 8)}`;
  const sock = join(screen.dir, `${tag}.sock`);
  const conf = join(screen.dir, `${tag}.conf`);
  writeFileSync(conf, '', { mode: 0o600 });
  const wayvnc = resolveBin({ name: 'wayvnc', env: 'WAYVNC_BIN', nix: 'wayvnc' }, () => {});
  const p = Bun.spawn([wayvnc, ...args, '-C', conf, '-u', '-k', 'us', '-S', join(screen.dir, `${tag}-ctl.sock`), sock], {
    env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: screen.socket, XDG_RUNTIME_DIR: screen.dir },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    const end = Date.now() + 10_000;
    while (!existsSync(sock)) {
      if (p.exitCode !== null || Date.now() > end) throw new Error(`wayvnc ${args.join(' ')} did not start: ${(await new Response(p.stderr).text()).slice(0, 300)}`);
      await Bun.sleep(25);
    }
    const out = await vnc(b, '/anim', encodings, sock, () => tree([p.pid]).map((x) => x.pid));
    p.kill();
    await p.exited;
    const said = (await new Response(p.stderr).text()).split('\n').filter(Boolean);
    return { ...out, ...(out.fps ? {} : { serverSaid: said.slice(-8) }) };
  } finally {
    p.kill();
    await p.exited;
  }
}

async function input(b: Bench, trials = 20) {
  await b.open('/input');
  await Bun.sleep(1000);
  const v = await Viewer.open(b.vncSocket, [ENC.raw, ENC.desktopSize], true);
  await new Promise<void>((r) => {
    const t = setInterval(() => v.updates > 0 && (clearInterval(t), r()), 20);
  });
  const toPage: number[] = [];
  const toHandler: number[] = [];
  const toPhoton: number[] = [];
  const page = b.reports.find((r) => r.ev === 'page');
  const [px, py] = [Math.round(W / 2), H - Math.round(page.h / 2)];
  let on = false;
  for (let i = 0; i < trials; i++) {
    on = !on;
    const want = on ? 255 : 0;
    const downs = b.reports.filter((r) => r.ev === 'down').length;
    const seen = new Promise<number>((resolve) => {
      v.onUpdate = () => {
        // Away from the pointer: x11vnc draws the cursor into the picture for a viewer that does not take it apart.
        const [r] = v.pixel(px + 80, py + 80);
        if (Math.abs(r - want) < 30) {
          v.onUpdate = null;
          resolve(performance.timeOrigin + performance.now());
        }
      };
    });
    const sent = performance.timeOrigin + performance.now();
    v.pointer(px, py, 1);
    v.pointer(px, py, 0);
    const photon = await Promise.race([seen, Bun.sleep(5000).then(() => NaN)]);
    
    const d = await b.until('pointerdown', (r) => r.ev === 'down' && b.reports.filter((x) => x.ev === 'down').indexOf(r) >= downs, 5000);
    toPage.push(d.eventAt - sent);
    toHandler.push(d.handlerAt - sent);
    toPhoton.push(photon - sent);
    await Bun.sleep(250);
  }
  v.close();
  return { toEvent: summary(toPage), toHandler: summary(toHandler), clickToPhoton: summary(toPhoton.filter((x) => !Number.isNaN(x))), lost: toPhoton.filter((x) => Number.isNaN(x)).length };
}

async function typing(b: Bench) {
  await b.open('/type');
  await Bun.sleep(500);
  const text = 'the quick brown fox jumps over the lazy dog 0123456789 '.repeat(4).slice(0, 200);
  const t0 = performance.now();
  await b.sb.screen!.type(text);
  await b.until('all 200 typed', (r) => r.ev === 'typed' && r.n >= 200, 120_000);
  const secs = (performance.now() - t0) / 1000;
  return { charsPerS: 200 / secs, seconds: secs };
}

/** Chromium's picker answered: on X by the source's name, under PipeWire only by the fake UI (docs/browser.md). */
function flagsFor(backend: Backend): string[] {
  return backend === 'x11' ? ['--auto-select-desktop-capture-source=Entire screen'] : ['--use-fake-ui-for-media-stream'];
}

/** In a sandbox of its own with screen sharing on (on wayland its own PipeWire and portal; on x11 nothing more). */
async function share(backend: Backend) {
  const b = new Bench(backend, flagsFor(backend), true);
  try {
    const start = await b.start();
    return { ...(await shareIn(b)), startMs: start.pageMs };
  } finally {
    await b.stop();
  }
}

async function shareIn(b: Bench) {
  await b.open('/share');
  await Bun.sleep(1000);
  const page = b.reports.find((r) => r.ev === 'page');
  const run = await cpuDuring(b.roots, async () => {
    await b.sb.screen!.click(200, page.sh - page.h + 300);
    return (await b.until('share stats', (r) => r.ev === 'stats' || r.ev === 'error', 90_000)) as Omit<ShareStats, 'ev'> & { ev: string; name?: string; message?: string };
  });
  if (run.result.ev === 'error') return { error: `${run.result.name}: ${run.result.message}` };
  const s = run.result;
  return { fps: s.fps, width: s.width, height: s.height, latencyP50: s.latency.p50, latencyP95: s.latency.p95, unreadable: s.bad, frames: s.frames, firstFrameMs: s.firstFrameMs, cpu: run.cpu, cpuByName: run.byName };
}

async function video(b: Bench) {
  if (!existsSync(VIDEO)) return { error: 'no test video (ffmpeg missing)' };
  await b.open('/video');
  const r = await cpuDuring(b.roots, () => b.until('video quality', (x) => x.ev === 'video', 60_000));
  return { total: r.result.total, dropped: r.result.dropped, droppedPct: (100 * r.result.dropped) / Math.max(1, r.result.total), size: `${r.result.w}x${r.result.h}`, cpu: r.cpu };
}

async function webgl(b: Bench) {
  await b.open('/webgl');
  const r = await cpuDuring(b.roots, () => b.until('webgl fps', (x) => x.ev === 'fps', 30_000));
  return { fps: r.result.fps, renderer: r.result.renderer, cpu: r.cpu };
}

async function shots(b: Bench, n = 10) {
  await b.open('/idle');
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await b.sb.screen!.screenshot();
    ms.push(performance.now() - t0);
  }
  return summary(ms);
}

async function idle(b: Bench) {
  await b.open('/idle');
  await Bun.sleep(10_000);
  const cpu = await cpuOver(b.roots, 10_000);
  const all = tree(b.roots());
  const byName: Record<string, { rssMB: number; pssMB: number }> = {};
  for (const p of all) {
    const name = progName(p);
    const m = memory([p]);
    byName[name] = { rssMB: (byName[name]?.rssMB ?? 0) + m.rssMB, pssMB: (byName[name]?.pssMB ?? 0) + m.pssMB };
  }
  return { cpu: cpu.total, cpuByName: cpu.byName, ...memory(all), memByName: byName, processes: all.length };
}

async function scale(backend: Backend, n: number) {
  const benches = Array.from({ length: n }, () => new Bench(backend));
  const t0 = performance.now();
  try {
    // One at a time picks X displays (each claims its own), then all start together.
    const displays: FreeDisplay[] = [];
    for (let i = 0; i < n; i++) displays.push(await pickFreeDisplay(undefined, displays.map((d) => d.display).filter((d): d is number => d !== null), backend));
    const starts = await Promise.all(benches.map((b, i) => b.start(displays[i])));
    const wall = performance.now() - t0;
    await Bun.sleep(15_000);
    const roots = () => benches.flatMap((b) => b.roots());
    const cpu = await cpuOver(roots, 10_000);
    const mem = memory(tree(roots()));
    return { n, wallMs: wall, startPage: summary(starts.map((s) => s.pageMs)), idleCpu: cpu.total, ...mem, perSandboxPssMB: mem.pssMB / n };
  } finally {
    await Promise.all(benches.map((b) => b.stop()));
  }
}

// ------------------------------------------------------------------------------------------------ run

const results: any = {
  when: new Date().toISOString(),
  machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(Number(/MemTotal:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1048576), gpu: readdirSync('/dev/dri').some((n) => n.startsWith('renderD')) },
  size: `${W}x${H}`,
  reps: REPS,
  maxLoad: MAX_LOAD,
  runs: [] as any[],
  scale: [] as any[],
};
const save = () => {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
};


try {
  for (let rep = 0; rep < REPS; rep++) {
    const order = rep % 2 ? [...BACKENDS].reverse() : [...BACKENDS];
    for (const backend of order) {
      const load = await quiet();
      log(`rep ${rep + 1}/${REPS} ${backend} (load ${load.load.toFixed(1)}${load.busy ? ', busy' : ''})`);
      const run: any = { rep, backend, load };
      const b = new Bench(backend);
      try {
        run.start = await b.start();
        const step = async (name: string, f: () => Promise<unknown>) => {
          if (!ONLY.has(name)) return;
          const l = load1();
          try {
            run[name] = await f();
          } catch (e) {
            run[name] = { error: (e as Error).message };
          }
          run[name].load = l;
          log(`  ${name}`, JSON.stringify(run[name]).slice(0, 200));
        };
        await step('idle', () => idle(b));
        await step('vnc', async () => ({
          anim: await vnc(b, '/anim', [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]),
          scroll: await vnc(b, '/scroll', [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]),
          ...(existsSync(VIDEO) ? { video: await vnc(b, '/video', [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]) } : {}),
          ...(backend === 'wayland'
            ? {
                anim60: await otherWayvnc(b, ['-f', '60'], [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]).catch((e) => ({ error: (e as Error).message })),
                animH264: await otherWayvnc(b, ['-g', '-f', '60'], [ENC.h264, ENC.zrle, ENC.raw, ENC.desktopSize]).catch((e) => ({ error: (e as Error).message })),
              }
            : {}),
        }));
        await step('input', () => input(b));
        await step('typing', () => typing(b));
        await step('share', () => share(backend));
        await step('video', () => video(b));
        await step('webgl', () => webgl(b));
        await step('shot', () => shots(b));
      } catch (e) {
        run.error = (e as Error).message;
        log('  failed', run.error);
      } finally {
        await b.stop();
      }
      results.runs.push(run);
      save();
    }
  }
  if (ONLY.has('scale'))
    for (const n of SCALE)
      for (const backend of BACKENDS) {
        const load = await quiet();
        log(`scale ${n} ${backend} (load ${load.load.toFixed(1)})`);
        try {
          results.scale.push({ backend, load, ...(await scale(backend, n)) });
        } catch (e) {
          results.scale.push({ backend, n, load, error: (e as Error).message });
        }
        save();
      }
} finally {
  save();
  rmSync(work, { recursive: true, force: true });
  log(`wrote ${OUT}`);
}
process.exit(0);
