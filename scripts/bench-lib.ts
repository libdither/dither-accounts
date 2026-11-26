/**
 * What the display benchmarks share (scripts/bench-display.ts, bench-link.ts, bench-native.ts): a process tree's CPU and
 * memory from /proc, waiting for a quiet machine, the test pages and a browser sandbox that shows them, and an RFB viewer
 * of our own. Temporary directories and ports only.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DISPLAY_BACKENDS, type DisplayBackend, parseBackend } from '@dither-accounts/spec/display';
import { BACKEND_BINS, DISPLAY_BINS, resolveBin, tryBin } from '../packages/browser/src/bins.ts';
import { type FreeDisplay, pickFreeDisplay } from '../packages/browser/src/display.ts';
import { Sandbox } from '../packages/browser/src/sandbox.ts';
import { sharePage } from '../packages/browser/test/share-page.ts';

export const W = 1280;
export const H = 800;
export const BACKENDS = DISPLAY_BACKENDS;
export type Backend = DisplayBackend;

/** `--backends x11,tigervnc,...` (default: every one whose programs can be had here), checked against the spec's list. */
export function backendsArg(argv = process.argv): Backend[] {
  const v = argOf('backends', '', argv);
  const want = v ? v.split(',').map((s) => s.trim()) : [...BACKENDS];
  for (const b of want) if (!parseBackend(b)) throw new Error(`--backends: no backend "${b}" (${BACKENDS.join(', ')})`);
  return (want as Backend[]).filter((b) => {
    const ok = BACKEND_BINS[b].every((x) => tryBin(x, () => {}));
    if (!ok) log(`skipping ${b}: its programs cannot be had here`);
    return ok;
  });
}

/** `--name value` from the command line, or the default: the one argument parser the bench scripts share. */
export function argOf(name: string, dflt: string, argv = process.argv): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : dflt;
}
/** `--name <number>`, or the default. */
export const numArg = (name: string, dflt: number, argv = process.argv) => Number(argOf(name, String(dflt), argv));
/** `--name` given at all. */
export const flagArg = (name: string, argv = process.argv) => argv.includes(`--${name}`);

/** The live view's server, by its name in /proc (progName): x11vnc, an Xvnc (KasmVNC's is Xkasmvnc), wayvnc, w0vncserver. */
export const VNC_SERVER: Record<Backend, string> = { x11: 'x11vnc', tigervnc: 'Xvnc', kasmvnc: 'Xkasmvnc', wayland: 'wayvnc', 'wayland-tigervnc': 'w0vncserver' };
/** Every process of the display: the display server and the live view's (one and the same for an Xvnc). */
export const DISPLAY_PROCS: Record<Backend, string[]> = { x11: ['Xvfb', 'x11vnc'], tigervnc: ['Xvnc'], kasmvnc: ['Xkasmvnc'], wayland: ['sway', 'wayvnc'], 'wayland-tigervnc': ['sway', 'w0vncserver'] };

/**
 * SysV shared memory segments (/proc/sysvipc/shm): all of the machine's, and those these processes made or last
 * attached (cpid, lpid). The machine's count has a limit (kernel.shmmni); x11vnc holds about 40 per display.
 */
export function shm(pids: number[] = []): { total: number; mine: number; limit: number } {
  const lines = readFileSync('/proc/sysvipc/shm', 'utf8').trim().split('\n');
  const head = lines[0]!.trim().split(/\s+/);
  const [c, l] = [head.indexOf('cpid'), head.indexOf('lpid')];
  const set = new Set(pids);
  const rows = lines.slice(1).map((x) => x.trim().split(/\s+/));
  let limit = NaN;
  try {
    limit = Number(readFileSync('/proc/sys/kernel/shmmni', 'utf8'));
  } catch {}
  return { total: rows.length, mine: rows.filter((f) => set.has(Number(f[c])) || set.has(Number(f[l]))).length, limit };
}
const HZ = 100; // clock ticks per second in /proc/<pid>/stat (USER_HZ)

export const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);
let work_: string | null = null;
/** The benchmark's temporary directory (removed by its caller at the end). */
export const work = () => (work_ ??= mkdtempSync(join(tmpdir(), 'da-bench-')));

// ------------------------------------------------------------------------------------------------ processes

export interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  ticks: number;
}
export function procs(): Map<number, Proc> {
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
export function tree(roots: number[], all = procs()): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of all.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  // Each process once, also when one root is another's descendant (a manager's list of an account's processes).
  const seen = new Set<number>();
  const walk = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const p = all.get(pid);
    if (p) out.push(p);
    for (const k of kids.get(pid) ?? []) walk(k.pid);
  };
  for (const r of roots) walk(r);
  return out;
}
/** The program's name without nix's wrapper marks (.wayvnc-wrapped → wayvnc). */
export const progName = (p: Proc) => p.comm.replace(/^\./, '').replace(/-wrapped$/, '').replace(/-wrapp?e?$/, '');
export function memory(ps: Proc[]): { rssMB: number; pssMB: number; ussMB: number } {
  let rss = 0;
  let pss = 0;
  let uss = 0;
  for (const p of ps) {
    try {
      const t = readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8');
      rss += Number(/^Rss:\s+(\d+)/m.exec(t)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(t)?.[1] ?? 0);
      // USS: pages no other process maps. PSS splits shared pages among every process mapping them, Chromiums of
      // other programs on the machine too, so it moves with what else runs; USS does not (it leaves those out).
      uss += Number(/^Private_Clean:\s+(\d+)/m.exec(t)?.[1] ?? 0) + Number(/^Private_Dirty:\s+(\d+)/m.exec(t)?.[1] ?? 0);
    } catch {}
  }
  return { rssMB: rss / 1024, pssMB: pss / 1024, ussMB: uss / 1024 };
}
/** CPU of a set of processes over a span: % of one core, in all and by program name. */
export async function cpuOver(roots: () => number[], ms: number): Promise<{ total: number; byName: Record<string, number> }> {
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
export async function cpuDuring<T>(roots: () => number[], f: () => Promise<T>): Promise<{ result: T; cpu: number; byName: Record<string, number> }> {
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

export const load1 = () => loadavg()[0]!;
/** Wait (up to waitS) for the 1-minute load to fall under maxLoad; busy when it did not. */
export async function quiet(maxLoad = cpus().length / 2, waitS = 600): Promise<{ load: number; busy: boolean; waitedS: number }> {
  const t0 = Date.now();
  while (load1() > maxLoad && Date.now() - t0 < waitS * 1000) {
    log(`load ${load1().toFixed(1)} > ${maxLoad}: waiting`);
    await Bun.sleep(15_000);
  }
  return { load: load1(), busy: load1() > maxLoad, waitedS: Math.round((Date.now() - t0) / 1000) };
}

// ------------------------------------------------------------------------------------------------ pages

const ffmpeg = () => {
  try {
    return resolveBin({ name: 'ffmpeg', env: 'FFMPEG_BIN', nix: 'ffmpeg-headless' }, () => {});
  } catch {
    return null;
  }
};
export const VIDEO = join(homedir(), '.cache/da-bench/video-720p30-vp9.webm');
/** The test video, made once with ffmpeg; false when it cannot be. */
export function ensureVideo(): boolean {
  if (existsSync(VIDEO)) return true;
  const bin = ffmpeg();
  if (!bin) return false;
  mkdirSync(dirname(VIDEO), { recursive: true });
  log('making the test video');
  const p = Bun.spawnSync([bin, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', VIDEO]);
  if (p.exitCode !== 0) log('ffmpeg failed', p.stderr.toString().slice(0, 300));
  return existsSync(VIDEO);
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

export const PAGES: Record<string, string> = {
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
  // Still: a page full of text, for the first whole picture.
  '/still': `<!doctype html><html><body style="margin:0;font:18px sans-serif">${Array.from({ length: 40 }, (_, i) => `<div style="height:48px;padding:8px 16px;background:hsl(${(i * 37) % 360},40%,${i % 2 ? 85 : 92}%)">Row ${i}: the quick brown fox jumps over the lazy dog, ${'lorem ipsum '.repeat(4)}</div>`).join('')}${STEER}</body></html>`,
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

export class Bench {
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
    this.dir = mkdtempSync(join(work(), `${backend}-`));
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

export { ENC, ENC_NAME, novncEncodings, Viewer, type ViewerOptions } from '../packages/browser/test/rfb-viewer.ts';

// ------------------------------------------------------------------------------------------------ numbers

export const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};
export const summary = (a: number[]) => ({ median: median(a), p10: q(a, 0.1), p90: q(a, 0.9), min: Math.min(...a), max: Math.max(...a), n: a.length });
