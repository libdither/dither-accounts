#!/usr/bin/env bun
/**
 * The live view over a constrained link and a constrained CPU, on both display backends (docs/browser.md, "Measured
 * side by side"): what a viewer gets when the link between it and the manager is slow, far or lossy, or when the
 * display's own processes get only part of a core.
 *
 *   bun scripts/bench-link.ts [--out link.json] [--reps 3] [--only base,bw20,...] [--max-load <load1>] [--wait-load-s 600]
 *
 * The viewer asks for what the manager's live view (noVNC) asks for, in its order and with its quality and
 * compression levels, and asks for the next update the way noVNC does (after the whole update, or continuous updates
 * with fences where the server offers them). The link is scripts/bench-shaper.ts: tc on the loopback of a network
 * namespace of our own, the server's output copied as the manager copies it. Each condition is checked first: the
 * throughput and round trip measured through it are stored with its numbers.
 *
 * For each condition, on each backend (one browser sandbox per backend and repetition):
 *   first      connect → the whole screen has arrived, on a still page full of text
 *   anim, scroll, video   frames delivered per second, bytes per second, the encodings used, 5 s after the first
 *              whole screen; the display processes' CPU (the VNC server and the display server)
 *   click      a press sent through the link → the page's handler, and → the first changed rectangle back (10 times)
 * The CPU conditions put the display processes (Xvfb and x11vnc, or sway and wayvnc) into a transient systemd scope
 * with a CPU quota; nothing else is touched. Encoding comparisons (Tight, ZRLE, wayvnc's Open H.264 with -g) run on
 * the full-screen animation at two conditions.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { connect, createServer, type Server } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { resolveBin } from '../packages/browser/src/bins.ts';
import { type Backend, BACKENDS, Bench, cpuOver, ENC, ensureVideo, log, median, novncEncodings, progName, quiet, summary, tree, Viewer, W, H, work } from './bench-lib.ts';

const SHAPER = resolve(import.meta.dir, 'bench-shaper.ts');

export interface Condition {
  name: string;
  label: string;
  rateMbit?: number;
  rttMs?: number;
  lossPct?: number;
  /** The display processes' CPU quota, % of one core. */
  cpuPct?: number;
  /** Also compare encodings here. */
  encodings?: boolean;
  /** Also measure with the live view's bridge unpaced, as it was before (bench-shaper.ts --bridge eager). */
  eager?: boolean;
  /** The bridge, when not paced. */
  bridge?: 'paced' | 'eager';
}

const BASE_CONDITIONS: Condition[] = [
  { name: 'base', label: 'unlimited', encodings: true },
  { name: 'bw20', label: '20 Mbit/s', rateMbit: 20 },
  { name: 'bw5', label: '5 Mbit/s', rateMbit: 5 },
  { name: 'bw1', label: '1 Mbit/s', rateMbit: 1 },
  { name: 'rtt20', label: '20 ms', rttMs: 20 },
  { name: 'rtt50', label: '50 ms', rttMs: 50 },
  { name: 'rtt150', label: '150 ms', rttMs: 150 },
  { name: 'bw20rtt20', label: '20 Mbit/s, 20 ms', rateMbit: 20, rttMs: 20 },
  { name: 'bw5rtt50', label: '5 Mbit/s, 50 ms', rateMbit: 5, rttMs: 50, encodings: true, eager: true },
  { name: 'bw1rtt150', label: '1 Mbit/s, 150 ms', rateMbit: 1, rttMs: 150, eager: true },
  { name: 'loss1', label: '20 Mbit/s, 50 ms, 1% loss', rateMbit: 20, rttMs: 50, lossPct: 1 },
  { name: 'cpu50', label: 'display at 50% of a core', cpuPct: 50 },
  { name: 'cpu20', label: 'display at 20% of a core', cpuPct: 20 },
];
/** Each condition, and those marked `eager` again with the bridge unpaced. */
export const CONDITIONS: Condition[] = BASE_CONDITIONS.flatMap((c) => (c.eager ? [c, { ...c, name: `${c.name}-eager`, label: `${c.label}, unpaced bridge`, bridge: 'eager' as const, encodings: false }] : [c]));

// ------------------------------------------------------------------------------------------------ the link

export interface Link {
  socket: string;
  qdisc: string[];
  stop(): Promise<{ dropped: number; droppedChunks: number; maxBuffered: number } | null>;
}

/** A shaped link to `target` (a Unix socket), as the condition says; its socket is in `dir`. */
export async function startLink(target: string, c: Condition, dir: string): Promise<Link> {
  const socket = join(dir, `link-${Math.random().toString(36).slice(2, 8)}.sock`);
  const p = Bun.spawn(
    ['unshare', '-rn', process.execPath, SHAPER, '--target', target, '--listen', socket, '--rate-mbit', String(c.rateMbit ?? 0), '--rtt-ms', String(c.rttMs ?? 0), '--loss-pct', String(c.lossPct ?? 0), '--bridge', c.bridge ?? 'paced'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let text = '';
  const line = async () => {
    for (;;) {
      const i = text.indexOf('\n');
      if (i >= 0) {
        const l = text.slice(0, i);
        text = text.slice(i + 1);
        return l;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`the shaper exited: ${(await new Response(p.stderr).text()).slice(0, 300)}`);
      text += dec.decode(value);
    }
  };
  const ready = JSON.parse(await line());
  return {
    socket,
    qdisc: ready.qdisc,
    async stop() {
      p.kill('SIGTERM');
      const out = await line().catch(() => null);
      await p.exited;
      return out ? JSON.parse(out) : null;
    },
  };
}

/**
 * The link measured: TCP goodput from a server that sends as fast as it can (3 s, after 1 s of slow start), and the
 * round trip of one byte, 10 times. Through the same shaper as the live view, to a test server of our own.
 */
export async function checkLink(c: Condition, dir: string): Promise<{ goodputMbit: number; rttMs: number; rttP90: number }> {
  const target = join(dir, `check-${Math.random().toString(36).slice(2, 8)}.sock`);
  const chunk = Buffer.alloc(64 * 1024, 7);
  const server: Server = createServer((s) => {
    s.on('error', () => {});
    s.once('data', (d: Buffer) => {
      if (d[0] === 0x45) {
        // Echo.
        s.write(d.subarray(1));
        s.on('data', (x: Buffer) => s.write(x));
        return;
      }
      // Blast, with backpressure (this is the link's measure, not the manager's).
      const pump = () => {
        while (!s.destroyed && s.write(chunk));
      };
      s.on('drain', pump);
      pump();
    });
  });
  await new Promise<void>((r) => server.listen(target, r));
  const link = await startLink(target, c, dir);
  try {
    // Round trips.
    const rtts: number[] = [];
    {
      const s = connect(link.socket);
      await new Promise<void>((r) => s.once('connect', () => r()));
      s.write('E');
      for (let i = 0; i < 11; i++) {
        const t0 = performance.now();
        const got = new Promise<void>((r) => s.once('data', () => r()));
        s.write('x');
        await got;
        if (i) rtts.push(performance.now() - t0);
        await Bun.sleep(20);
      }
      s.destroy();
    }
    // Goodput.
    let bytes = 0;
    const s = connect(link.socket);
    s.on('error', () => {});
    s.on('data', (d) => (bytes += d.length));
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write('B');
    await Bun.sleep(1000 + (c.rttMs ?? 0) * 4);
    const b0 = bytes;
    const t0 = performance.now();
    await Bun.sleep(3000);
    const goodputMbit = ((bytes - b0) * 8) / ((performance.now() - t0) / 1000) / 1e6;
    s.destroy();
    return { goodputMbit, rttMs: median(rtts), rttP90: summary(rtts).p90 };
  } finally {
    await link.stop();
    server.close();
    rmSync(target, { force: true });
  }
}

// ------------------------------------------------------------------------------------------------ CPU quota

/** The display processes into a transient scope of their own with a CPU quota (% of one core), or the quota changed. */
function cpuQuota(scope: string, pids: number[], pct: number | null, exists: boolean) {
  if (exists) {
    const p = Bun.spawnSync(['systemctl', '--user', 'set-property', '--runtime', scope, `CPUQuota=${pct === null ? '' : `${pct}%`}`], { stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error(`set-property: ${p.stderr.toString().trim()}`);
    return;
  }
  // CPUQuotaPerSecUSec: microseconds of CPU a second (UINT64_MAX: no quota).
  const usec = pct === null ? '18446744073709551615' : String(pct * 10_000);
  const p = Bun.spawnSync(
    ['busctl', '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', scope, 'fail', '2', 'PIDs', 'au', String(pids.length), ...pids.map(String), 'CPUQuotaPerSecUSec', 't', usec, '0'],
    { stderr: 'pipe' },
  );
  if (p.exitCode !== 0) throw new Error(`StartTransientUnit: ${p.stderr.toString().trim()}`);
}

// ------------------------------------------------------------------------------------------------ measurements

const DISPLAY: Record<Backend, string[]> = { x11: ['Xvfb', 'x11vnc'], wayland: ['sway', 'wayvnc'] };
const displayPids = (b: Bench) => tree(b.roots()).filter((p) => DISPLAY[b.backend].includes(progName(p))).map((p) => p.pid);

/** Until the sum of pixel rectangles since connecting covers the screen (the first whole picture). */
function whole(v: Viewer): Promise<number> {
  let area = 0;
  return new Promise((r) => {
    v.onRect = (_x, _y, w, h) => {
      area += w * h;
      if (area >= v.width * v.height) {
        v.onRect = null;
        r(performance.now());
      }
    };
  });
}

const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`${what}: nothing within ${ms} ms`)))]);

async function first(b: Bench, socket: string) {
  await b.open('/still');
  await Bun.sleep(500);
  const t0 = performance.now();
  const v = await Viewer.open(socket, { encodings: novncEncodings(), mode: 'novnc' });
  try {
    const at = await within(whole(v), 60_000, 'the first whole screen');
    return { ms: at - t0, connectMs: v.t.init - t0, bytes: v.bytes, encodings: v.encodings };
  } finally {
    v.close();
  }
}

async function scene(b: Bench, socket: string, page: '/anim' | '/scroll' | '/video', encodings = novncEncodings(), server?: () => number[]) {
  await b.open(page);
  await Bun.sleep(1000);
  const v = await Viewer.open(socket, { encodings, mode: 'novnc' });
  try {
    await within(whole(v), 60_000, 'the first whole screen');
    await Bun.sleep(1000);
    const [u0, by0] = [v.updates, v.bytes];
    v.encodings = {};
    const t0 = performance.now();
    const cpu = await cpuOver(server ?? (() => displayPids(b)), 5000);
    const secs = (performance.now() - t0) / 1000;
    if (v.error) throw new Error(`the viewer: ${v.error}`);
    return { fps: (v.updates - u0) / secs, bytesPerS: (v.bytes - by0) / secs, encodings: v.encodings, cpu: cpu.total, cpuByName: cpu.byName, pageFps: b.reports.filter((r) => r.ev === 'fps').pop()?.fps ?? null };
  } finally {
    v.close();
  }
}

async function click(b: Bench, socket: string, trials = 10) {
  await b.open('/input');
  await Bun.sleep(500);
  const v = await Viewer.open(socket, { encodings: novncEncodings(), mode: 'novnc' });
  try {
    await within(whole(v), 60_000, 'the first whole screen');
    const page = b.reports.find((r) => r.ev === 'page');
    const [px, py] = [Math.round(W / 2), H - Math.round(page.h / 2)];
    const toHandler: number[] = [];
    const toPhoton: number[] = [];
    let lost = 0;
    for (let i = 0; i < trials; i++) {
      // Quiet first: nothing has arrived for 300 ms.
      let last = performance.now();
      v.onUpdate = () => (last = performance.now());
      while (performance.now() - last < 300) await Bun.sleep(50);
      const downs = b.reports.filter((r) => r.ev === 'down').length;
      const sent = performance.now();
      const seen = new Promise<number>((r) => {
        v.onRect = (x, y, w, h) => {
          if (px + 80 >= x && px + 80 < x + w && py + 80 >= y && py + 80 < y + h) {
            v.onRect = null;
            r(performance.now());
          }
        };
      });
      v.pointer(px, py, 1);
      v.pointer(px, py, 0);
      const photon = await Promise.race([seen, Bun.sleep(10_000).then(() => NaN)]);
      if (Number.isNaN(photon)) lost++;
      else toPhoton.push(photon - sent);
      const d = await b.until('pointerdown', (r) => r.ev === 'down' && b.reports.filter((x) => x.ev === 'down').indexOf(r) >= downs, 10_000).catch(() => null);
      if (d) toHandler.push(d.handlerAt - (performance.timeOrigin + sent));
    }
    v.onUpdate = null;
    return { toHandler: summary(toHandler), clickToPhoton: summary(toPhoton), lost };
  } finally {
    v.close();
  }
}

/** A second wayvnc on the same compositor with other flags (-g: its GPU features, Open H.264), on a socket of its own. */
async function withOtherWayvnc<T>(b: Bench, args: string[], f: (socket: string, pids: () => number[]) => Promise<T>): Promise<T> {
  const screen = b.sb.screen as unknown as { dir: string; socket: string };
  const tag = `bench-${Math.random().toString(36).slice(2, 8)}`;
  const sock = join(screen.dir, `${tag}.sock`);
  const conf = join(screen.dir, `${tag}.conf`);
  writeFileSync(conf, '', { mode: 0o600 });
  const wayvnc = resolveBin({ name: 'wayvnc', env: 'WAYVNC_BIN', nix: 'wayvnc' }, () => {});
  const p = Bun.spawn([wayvnc, ...args, '-C', conf, '-u', '-k', 'us', '-S', join(screen.dir, `${tag}-ctl.sock`), sock], {
    env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: screen.socket, XDG_RUNTIME_DIR: screen.dir },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    const end = Date.now() + 10_000;
    while (!existsSync(sock)) {
      if (p.exitCode !== null || Date.now() > end) throw new Error(`wayvnc ${args.join(' ')} did not start`);
      await Bun.sleep(25);
    }
    return await f(sock, () => tree([p.pid]).map((x) => x.pid));
  } finally {
    p.kill();
    await p.exited;
  }
}

/** The full-screen animation with other encodings through the same condition's link. */
async function encodingsAt(b: Bench, c: Condition, dir: string) {
  const out: Record<string, unknown> = {};
  const via = async (target: string, f: (socket: string) => Promise<unknown>) => {
    const link = await startLink(target, c, dir);
    try {
      return await f(link.socket);
    } catch (e) {
      return { error: (e as Error).message };
    } finally {
      await link.stop();
    }
  };
  const zrle = [ENC.zrle, ENC.raw, ENC.copyRect, ENC.desktopSize, ENC.lastRect, ENC.cursor, ENC.fence, ENC.continuousUpdates];
  out.zrle = await via(b.vncSocket, (s) => scene(b, s, '/anim', zrle));
  if (b.backend === 'wayland')
    out.h264 = await withOtherWayvnc(b, ['-g', '-f', '60'], async (sock, pids) => via(sock, (s) => within(scene(b, s, '/anim', novncEncodings(true), pids), 30_000, 'Open H.264'))).catch((e) => ({ error: (e as Error).message }));
  return out;
}

// ------------------------------------------------------------------------------------------------ run

if (import.meta.main) {
  const argOf = (name: string, def: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1]! : def;
  };
  const OUT = argOf('out', join(homedir(), '.cache/da-bench', `link-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const REPS = Number(argOf('reps', '3'));
  const ONLY = new Set(argOf('only', CONDITIONS.map((c) => c.name).join(',')).split(','));
  const MAX_LOAD = Number(argOf('max-load', String(cpus().length / 2)));
  const WAIT_LOAD_S = Number(argOf('wait-load-s', '600'));
  const conditions = CONDITIONS.filter((c) => ONLY.has(c.name));
  const hasVideo = ensureVideo();
  const results: any = { when: new Date().toISOString(), machine: { cpus: cpus().length, model: cpus()[0]?.model }, size: `${W}x${H}`, reps: REPS, maxLoad: MAX_LOAD, conditions, checks: [] as any[], runs: [] as any[] };
  const save = () => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  };
  const dir = mkdtempSync(join(work(), 'link-'));
  try {
    // The links themselves, once each.
    for (const c of conditions.filter((c) => !c.cpuPct)) {
      const check = await checkLink(c, dir).catch((e) => ({ error: (e as Error).message }));
      log(`link ${c.name}`, JSON.stringify(check));
      results.checks.push({ name: c.name, ...check });
      save();
    }
    for (let rep = 0; rep < REPS; rep++) {
      const order = rep % 2 ? [...BACKENDS].reverse() : [...BACKENDS];
      for (const backend of order) {
        const b = new Bench(backend);
        const scope = `da-bench-display-${process.pid}-${rep}-${backend}.scope`;
        let scoped = false;
        try {
          await b.start();
          for (const c of conditions) {
            const load = await quiet(MAX_LOAD, WAIT_LOAD_S);
            log(`rep ${rep + 1}/${REPS} ${backend} ${c.name} (load ${load.load.toFixed(1)}${load.busy ? ', busy' : ''})`);
            const run: any = { rep, backend, condition: c.name, load };
            if (c.cpuPct) {
              cpuQuota(scope, displayPids(b), c.cpuPct, scoped);
              scoped = true;
            } else if (scoped) cpuQuota(scope, [], null, true);
            const link = await startLink(b.vncSocket, c.cpuPct ? { name: 'direct', label: '' } : c, dir);
            const step = async (name: string, f: () => Promise<unknown>) => {
              try {
                run[name] = await f();
              } catch (e) {
                run[name] = { error: (e as Error).message };
              }
              log(`  ${name}`, JSON.stringify(run[name]).slice(0, 220));
            };
            try {
              await step('first', () => first(b, link.socket));
              await step('anim', () => scene(b, link.socket, '/anim'));
              await step('scroll', () => scene(b, link.socket, '/scroll'));
              if (hasVideo) await step('video', () => scene(b, link.socket, '/video'));
              await step('click', () => click(b, link.socket));
            } finally {
              run.link = await link.stop();
            }
            if (c.encodings) await step('enc', () => encodingsAt(b, c, dir));
            results.runs.push(run);
            save();
          }
        } catch (e) {
          results.runs.push({ rep, backend, error: (e as Error).message });
          log('  failed', (e as Error).message);
        } finally {
          await b.stop();
        }
      }
    }
  } finally {
    save();
    rmSync(work(), { recursive: true, force: true });
    log(`wrote ${OUT}`);
  }
  process.exit(0);
}
