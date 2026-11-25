/**
 * What the display benchmarks share (scripts/bench-display.ts, bench-link.ts, bench-native.ts): a process tree's CPU and
 * memory from /proc, waiting for a quiet machine, the test pages and a browser sandbox that shows them, and an RFB viewer
 * of our own. Temporary directories and ports only.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { DISPLAY_BINS, resolveBin, tryBin } from '../packages/browser/src/bins.ts';
import { type FreeDisplay, pickFreeDisplay } from '../packages/browser/src/display.ts';
import { Sandbox } from '../packages/browser/src/sandbox.ts';
import { sharePage } from '../packages/browser/test/share-page.ts';

export const W = 1280;
export const H = 800;
export const BACKENDS = ['x11', 'tigervnc', 'kasmvnc', 'turbovnc', 'wayland'] as const;
export type Backend = (typeof BACKENDS)[number];

/** `--backends x11,tigervnc,...` (default: every one whose programs can be had here), checked against BACKENDS. */
export function backendsArg(argv = process.argv): Backend[] {
  const i = argv.indexOf('--backends');
  const want = i >= 0 ? argv[i + 1]!.split(',').map((s) => s.trim()) : [...BACKENDS];
  for (const b of want) if (!(BACKENDS as readonly string[]).includes(b)) throw new Error(`--backends: no backend "${b}" (${BACKENDS.join(', ')})`);
  return (want as Backend[]).filter((b) => {
    const bins = b === 'x11' ? [DISPLAY_BINS.xvfb, DISPLAY_BINS.x11vnc] : b === 'wayland' ? [DISPLAY_BINS.sway, DISPLAY_BINS.wayvnc] : [DISPLAY_BINS[b]];
    const ok = bins.every((x) => tryBin(x, () => {}));
    if (!ok) log(`skipping ${b}: its programs cannot be had here`);
    return ok;
  });
}

/** The live view's server, by its name in /proc (progName): x11vnc, an Xvnc (KasmVNC's is Xkasmvnc), wayvnc. */
export const VNC_SERVER: Record<Backend, string> = { x11: 'x11vnc', tigervnc: 'Xvnc', kasmvnc: 'Xkasmvnc', turbovnc: 'Xvnc', wayland: 'wayvnc' };
/** Every process of the display: the display server and the live view's (one and the same for an Xvnc). */
export const DISPLAY_PROCS: Record<Backend, string[]> = { x11: ['Xvfb', 'x11vnc'], tigervnc: ['Xvnc'], kasmvnc: ['Xkasmvnc'], turbovnc: ['Xvnc'], wayland: ['sway', 'wayvnc'] };

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

// ------------------------------------------------------------------------------------------------ a viewer

export const ENC = {
  raw: 0,
  copyRect: 1,
  rre: 2,
  hextile: 5,
  zlib: 6,
  tight: 7,
  zrle: 16,
  jpeg: 21,
  h264: 50,
  tightPng: -260,
  desktopSize: -223,
  lastRect: -224,
  cursor: -239,
  qemuKey: -258,
  qemuLed: -261,
  desktopName: -307,
  extDesktopSize: -308,
  xvp: -309,
  fence: -312,
  continuousUpdates: -313,
  extMouseButtons: -316,
  vmwareCursor: 0x574d5664,
  extClipboard: 0xc0a1e5ce | 0,
  /** KasmVNC's: Tight rectangles as WebP (Tight subtype 0x0b) for a client that asks, as its own web client does. */
  kasmWebp: -1024,
  /** KasmVNC's lossless QOI (Tight subtype 0x0c), which its client asks for only when told to. */
  kasmQoi: -1886,
  /** Quality level n is qualityLevel0 + n; compress level n is compressLevel0 + n. */
  qualityLevel0: -32,
  compressLevel0: -256,
} as const;
const TIGHT_KIND: Record<number, string> = { 8: 'fill', 9: 'jpeg', 10: 'png', 11: 'webp', 12: 'qoi', 13: 'kasm-0x0d' };
export const ENC_NAME: Record<number, string> = { 0: 'raw', 1: 'copyrect', 5: 'hextile', 6: 'zlib', 7: 'tight', 16: 'zrle', 50: 'open-h264', [-260]: 'tightpng', [-223]: 'desktop-size', [-224]: 'last-rect', [-239]: 'cursor', [ENC.vmwareCursor]: 'vmware-cursor', [-307]: 'desktop-name', [-308]: 'ext-desktop-size', [-261]: 'led' };

/**
 * What the manager's live view asks for: noVNC 1.7's list in its order (core/rfb.js, _sendEncodings) at 24-bit depth,
 * with its default quality 6 and compression 2. noVNC puts Open H.264 after CopyRect when the browser decodes H.264
 * with WebCodecs (Chromium and Firefox do), so `h264` adds it as the manager's page would.
 */
export function novncEncodings(h264 = true): number[] {
  return [
    ENC.copyRect,
    ...(h264 ? [ENC.h264] : []),
    ENC.tight,
    ENC.tightPng,
    ENC.zrle,
    ENC.jpeg,
    ENC.hextile,
    ENC.rre,
    ENC.zlib,
    ENC.raw,
    ENC.qualityLevel0 + 6,
    ENC.compressLevel0 + 2,
    ENC.desktopSize,
    ENC.lastRect,
    ENC.qemuKey,
    ENC.qemuLed,
    ENC.extDesktopSize,
    ENC.xvp,
    ENC.fence,
    ENC.continuousUpdates,
    ENC.desktopName,
    ENC.extClipboard,
    ENC.extMouseButtons,
    ENC.vmwareCursor,
    ENC.cursor,
  ];
}

export interface ViewerOptions {
  encodings: number[];
  /** Keep the picture (only raw rectangles are drawn into it). */
  keepPicture?: boolean;
  /**
   * When to ask for the next update. `novnc`: once the whole update has arrived, and continuous updates and fences as
   * noVNC answers them (what the manager's live view does). `eager`: as soon as an update's header arrives.
   */
  mode?: 'novnc' | 'eager';
  /** Pointer events in KasmVNC's own layout (a 16-bit mask and two scroll fields), as its web client sends them. */
  kasmPointer?: boolean;
}

/** A viewer: asks for every frame (incremental), counts them and their bytes, and keeps the picture when raw. */
export class Viewer {
  private sock: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private wait: (() => void) | null = null;
  private closed = false;
  private mode: 'novnc' | 'eager' = 'eager';
  private kasmPointer = false;
  private continuous = false;
  width = 0;
  height = 0;
  /** FramebufferUpdate messages, empty ones too: a server with continuous updates sends many small ones. */
  updates = 0;
  /**
   * Frames as a 60 Hz screen would show them: the 1/60 s slots in which pixels arrived. A server that splits one frame
   * over several updates (TigerVNC, TurboVNC with continuous updates) counts once per slot, so this is what to compare;
   * `updates` is not.
   */
  frames = 0;
  private slot = -1;
  bytes = 0;
  encodings: Record<string, number> = {};
  /** Tight rectangles by their kind: fill, jpeg, png, webp, qoi, basic (zlib) — what the bytes went to. */
  tightKinds: Record<string, number> = {};
  /** Server messages beyond updates (continuous-updates, fence, clipboard...): how many of each. */
  messages: Record<string, number> = {};
  fb: Uint8Array | null = null;
  /** performance.now() at: the socket connected, the server's init arrived, the first whole update arrived. */
  t = { open: 0, connected: 0, init: 0, firstFrame: 0 };
  error: string | null = null;
  /** Called after each whole update. */
  onUpdate: (() => void) | null = null;
  /** Called for each rectangle of pixels as soon as it has arrived. */
  onRect: ((x: number, y: number, w: number, h: number, enc: number) => void) | null = null;

  private constructor(path: string) {
    this.t.open = performance.now();
    this.sock = connect(path);
    this.sock.on('connect', () => (this.t.connected = performance.now()));
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

  static async open(path: string, encodings: number[] | ViewerOptions, keepPicture = false): Promise<Viewer> {
    const o: ViewerOptions = Array.isArray(encodings) ? { encodings, keepPicture } : encodings;
    const v = new Viewer(path);
    v.mode = o.mode ?? 'eager';
    v.kasmPointer = !!o.kasmPointer;
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
    v.t.init = performance.now();
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
    const se = Buffer.alloc(4 + 4 * o.encodings.length);
    se[0] = 2;
    se.writeUInt16BE(o.encodings.length, 2);
    o.encodings.forEach((e, i) => se.writeInt32BE(e | 0, 4 + 4 * i));
    v.sock.write(se);
    if (o.keepPicture) v.fb = new Uint8Array(v.width * v.height * 4);
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

  /** Tight's compact length: 1 to 3 bytes, 7 bits each. */
  private async compactLength(): Promise<number> {
    let len = 0;
    for (let i = 0; i < 3; i++) {
      const b = (await this.need(1))[0]!;
      len |= (i === 2 ? b : b & 0x7f) << (7 * i);
      if (!(b & 0x80) || i === 2) break;
    }
    return len;
  }

  /** A Tight (or TightPNG) rectangle's bytes, read past without decoding (pixels are 3 bytes at depth 24). */
  private async tight(w: number, h: number) {
    const ctl = (await this.need(1))[0]!;
    const kind = ctl >> 4;
    const name = TIGHT_KIND[kind] ?? (kind < 8 ? 'basic' : `kind${kind}`);
    this.tightKinds[name] = (this.tightKinds[name] ?? 0) + 1;
    if (kind === 8) return void (await this.need(3));
    // JPEG, PNG (TightPNG), and KasmVNC's WebP, QOI and 0x0d: a compact length, then that many bytes.
    if (kind >= 9 && kind <= 13) return void (await this.need(await this.compactLength()));
    if (kind > 13) throw new Error(`Tight subtype ${kind}, which this viewer does not read`);
    let size = w * h * 3;
    if (kind & 4) {
      const filter = (await this.need(1))[0]!;
      if (filter === 1) {
        const colours = (await this.need(1))[0]! + 1;
        await this.need(colours * 3);
        size = colours === 2 ? ((w + 7) >> 3) * h : w * h;
      }
    }
    if (size < 12) await this.need(size);
    else await this.need(await this.compactLength());
  }

  /**
   * The JPEG encoding (21, TigerVNC's for noVNC): a bare JPEG with no length before it, read as noVNC does, marker by
   * marker to the end-of-image, the entropy-coded data after SOS scanned in the buffer (not byte by byte).
   */
  private async jpeg() {
    await this.need(2); // SOI
    for (;;) {
      const m = await this.need(2);
      if (m[0] !== 0xff) throw new Error('JPEG: a marker expected');
      const t = m[1]!;
      if (t === 0xd9) return; // EOI
      if ((t >= 0xd0 && t <= 0xd7) || t === 0x01) continue;
      await this.need((await this.need(2)).readUInt16BE(0) - 2);
      if (t !== 0xda) continue;
      // After the scan header: data up to the next marker (0xff not followed by 0x00 or a restart marker).
      for (let from = 0; ; ) {
        const i = this.buf.indexOf(0xff, from);
        if (i >= 0 && i + 1 < this.buf.length) {
          const n = this.buf[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            from = i + 2;
            continue;
          }
          await this.need(i);
          break;
        }
        from = i >= 0 ? i : this.buf.length;
        if (this.closed) throw new Error('the server closed the connection');
        await new Promise<void>((r) => (this.wait = r));
      }
    }
  }

  private count(name: string) {
    this.messages[name] = (this.messages[name] ?? 0) + 1;
  }

  private async loop() {
    this.request(false);
    try {
      for (;;) {
        const type = (await this.need(1))[0];
        if (type === 0) {
          const h = await this.need(3);
          let rects = h.readUInt16BE(1);
          let pixels = false;
          if (this.mode === 'eager') this.request(true);
          while (rects-- > 0) {
            const r = await this.need(12);
            const [x, y, w, hh, enc] = [r.readUInt16BE(0), r.readUInt16BE(2), r.readUInt16BE(4), r.readUInt16BE(6), r.readInt32BE(8)];
            const name = ENC_NAME[enc] ?? String(enc);
            this.encodings[name] = (this.encodings[name] ?? 0) + 1;
            if (enc === ENC.raw) {
              const px = await this.need(w * hh * 4);
              if (this.fb) for (let row = 0; row < hh; row++) this.fb.set(px.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
            } else if (enc === ENC.copyRect) await this.need(4);
            else if (enc === ENC.zrle || enc === ENC.zlib) await this.need((await this.need(4)).readUInt32BE(0));
            else if (enc === ENC.tight || enc === ENC.tightPng) await this.tight(w, hh);
            else if (enc === ENC.jpeg) await this.jpeg();
            else if (enc === ENC.h264) {
              const l = (await this.need(8)).readUInt32BE(0);
              await this.need(l);
            } else if (enc === ENC.desktopSize) {
              this.width = w;
              this.height = hh;
            } else if (enc === ENC.extDesktopSize) {
              const screens = (await this.need(4))[0]!;
              await this.need(16 * screens);
              this.width = w;
              this.height = hh;
            } else if (enc === ENC.cursor) await this.need(w * hh * 4 + ((w + 7) >> 3) * hh);
            else if (enc === ENC.vmwareCursor) {
              const kind = (await this.need(2))[0];
              await this.need(kind === 0 ? 2 * w * hh * 4 : w * hh * 4);
            } else if (enc === ENC.desktopName) await this.need((await this.need(4)).readUInt32BE(0));
            else if (enc === ENC.qemuLed) await this.need(1);
            else if (enc === ENC.lastRect) break;
            else if (enc >= 0) throw new Error(`the server used encoding ${enc}, which this viewer does not read`);
            // Other pseudo-encodings (an acknowledgement that the server has the extension) carry nothing.
            if (enc >= 0) {
              pixels = true;
              this.onRect?.(x, y, w, hh, enc);
            }
          }
          this.updates++;
          if (pixels) {
            const slot = Math.floor(performance.now() / (1000 / 60));
            if (slot !== this.slot) [this.slot, this.frames] = [slot, this.frames + 1];
          }
          if (!this.t.firstFrame) this.t.firstFrame = performance.now();
          if (this.mode === 'novnc' && !this.continuous) this.request(true);
          this.onUpdate?.();
        } else if (type === 1) {
          const h = await this.need(5);
          await this.need(h.readUInt16BE(3) * 6);
        } else if (type === 2) {
          // bell
        } else if (type === 3) {
          await this.need(3);
          await this.need(Math.abs((await this.need(4)).readInt32BE(0)));
          this.count('cut-text');
        } else if (type === 150) {
          // EndOfContinuousUpdates: the server has them. noVNC turns them on at once, over the whole screen.
          this.count('end-of-continuous-updates');
          if (this.mode === 'novnc' && !this.continuous) {
            this.continuous = true;
            const m = Buffer.alloc(10);
            m[0] = 150;
            m[1] = 1;
            m.writeUInt16BE(this.width, 6);
            m.writeUInt16BE(this.height, 8);
            this.sock.write(m);
          }
        } else if (type === 248) {
          // A fence from the server: answered with its flags (block before / after only) and payload, as noVNC does.
          const h = await this.need(8);
          const flags = h.readUInt32BE(3);
          const payload = Buffer.from(await this.need(h[7]!));
          this.count('fence');
          const m = Buffer.alloc(9 + payload.length);
          m[0] = 248;
          m.writeUInt32BE((flags & 3) >>> 0, 4);
          m[8] = payload.length;
          payload.copy(m, 9);
          this.sock.write(m);
        } else if (type === 250) {
          await this.need(3);
          this.count('xvp');
        } else if (type === 253 || type === 254) {
          // KasmVNC's own: a viewer joined or left the session (a string: u32 length, then the bytes).
          await this.need((await this.need(4)).readUInt32BE(0));
          this.count(type === 253 ? 'kasm-user-joined' : 'kasm-user-left');
        } else throw new Error(`server message ${type}`);
      }
    } catch (e) {
      if (!this.closed) this.error = (e as Error).message;
    }
  }

  /** The pixel's RGB from the kept picture. */
  pixel(x: number, y: number): [number, number, number] {
    const o = (y * this.width + x) * 4;
    return [this.fb![o + 2]!, this.fb![o + 1]!, this.fb![o]!];
  }

  pointer(x: number, y: number, mask: number) {
    const k = this.kasmPointer;
    const b = Buffer.alloc(k ? 11 : 6);
    b[0] = 5;
    if (k) b.writeUInt16BE(mask, 1);
    else b[1] = mask;
    b.writeUInt16BE(x, k ? 3 : 2);
    b.writeUInt16BE(y, k ? 5 : 4);
    this.sock.write(b);
  }

  close() {
    this.closed = true;
    this.sock.destroy();
  }
}

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
