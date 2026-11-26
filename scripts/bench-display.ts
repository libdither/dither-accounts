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
 *             the encodings the server used, the VNC server's CPU, during a full-screen animation, a page scrolling,
 *             a video playing and a still page; on wayland again from a second wayvnc at its own default of 30 frames
 *             a second (the sandbox's sends up to 60), and from one with its GPU features (-g), with and without Open
 *             H.264 asked for
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DISPLAY_BINS, resolveBin } from '../packages/browser/src/bins.ts';
import { type FreeDisplay, pickFreeDisplay } from '../packages/browser/src/display.ts';
import type { ShareStats } from '../packages/browser/test/share-page.ts';
import { type Backend, BACKENDS, Bench, cpuDuring, cpuOver, ENC, ensureVideo, H, load1, log, memory, progName, quiet as quietFor, summary, tree, VIDEO, Viewer, W, work } from './bench-lib.ts';

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
const quiet = () => quietFor(MAX_LOAD, WAIT_LOAD_S);
if (ONLY.has('video')) ensureVideo();

// ------------------------------------------------------------------------------------------------ the measurements


async function vnc(b: Bench, page: '/anim' | '/scroll' | '/video' | '/idle', encodings: number[], socket = b.vncSocket, server?: () => number[]) {
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
async function otherWayvnc(b: Bench, args: string[], encodings: number[], page: '/anim' | '/idle' = '/anim') {
  const screen = b.sb.screen as unknown as { dir: string; socket: string };
  const tag = `bench-${Math.random().toString(36).slice(2, 8)}`;
  const sock = join(screen.dir, `${tag}.sock`);
  const conf = join(screen.dir, `${tag}.conf`);
  writeFileSync(conf, '', { mode: 0o600 });
  const wayvnc = resolveBin(DISPLAY_BINS.wayvnc, () => {});
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
    const out = await Promise.race([vnc(b, page, encodings, sock, () => tree([p.pid]).map((x) => x.pid)), Bun.sleep(30_000).then(() => ({ fps: 0, bytesPerS: 0, encodings: {}, serverCpu: NaN, pageFps: null, timedOut: true }))]);
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
          idle: await vnc(b, '/idle', [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]),
          ...(backend === 'wayland'
            ? {
                // The sandbox's wayvnc sends up to 60 frames a second; wayvnc's own default, 30, beside it.
                anim30: await otherWayvnc(b, ['-f', '30'], [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]).catch((e) => ({ error: (e as Error).message })),
                idle30: await otherWayvnc(b, ['-f', '30'], [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize], '/idle').catch((e) => ({ error: (e as Error).message })),
                // -g: its GPU features, without Open H.264 asked for and with it.
                animGpu: await otherWayvnc(b, ['-g', '-f', '60'], [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize]).catch((e) => ({ error: (e as Error).message })),
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
  rmSync(work(), { recursive: true, force: true });
  log(`wrote ${OUT}`);
}
process.exit(0);
