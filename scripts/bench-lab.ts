#!/usr/bin/env bun
/**
 * Real programs on each display backend: signed-in accounts of a running manager (a test manager, never the one you
 * use), each moved to a backend in turn by its `displayBackend` setting (which restarts it), then measured through its
 * own live view socket as the manager's page would use it. Read-only: the only input is the pointer swept over the
 * account's list (rows redraw as it hovers) and clicks that only change what is shown (Proton's Inbox, Sent and Starred;
 * Discord's Friends tabs). Nothing is typed, opened, sent or marked. (The lab's inboxes are too short to scroll: the
 * live view under scrolling is measured on bench-display's /scroll page.)
 *
 *   bun scripts/bench-lab.ts --url http://127.0.0.1:<port> --data <its data dir> --accounts <id>,<id>
 *                            [--backends x11,tigervnc,wayland] [--reps 1] [--first-rep 0] [--out lab.json]
 *                            [--no-restore]
 *
 * For each account and backend: start to usable (the setting saved, until the manager says online and until the live
 * view shows a drawn screen: many colours, then the same picture for 2 s), idle CPU over 10 s and memory (PSS) after
 * 20 s settling, the display's own share; interacting (frames/s and bytes/s the live view got, CPU of the whole tree);
 * then the same interaction through a shaped link (scripts/bench-shaper.ts: 5 Mbit/s with 50 ms, 1 Mbit/s with 150 ms): the first
 * whole screen and the interaction. At the end each account goes back to the manager's default (unless --no-restore).
 *
 * An account that does not come online, or shows a checkpoint, is left as it is and noted: nothing is solved here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argOf, type Backend, DISPLAY_PROCS, Viewer, cpuOver, load1, log, memory, novncEncodings, procs, progName, tree } from './bench-lib.ts';
import { type Condition, startLink } from './bench-link.ts';

const URL_ = argOf('url', '').replace(/\/$/, '');
const DATA = argOf('data', '');
const IDS = argOf('accounts', '').split(',').filter(Boolean);
const BACKENDS = argOf('backends', 'x11,tigervnc,wayland').split(',') as Backend[];
const REPS = Number(argOf('reps', '1'));
/** The first repetition's number: a later run goes on from there, so its backend order differs from the first run's. */
const FIRST_REP = Number(argOf('first-rep', '0'));
const OUT = argOf('out', join(homedir(), '.cache/da-bench', `lab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const RESTORE = !process.argv.includes('--no-restore');
if (!URL_ || !DATA || !IDS.length) throw new Error('--url, --data and --accounts are needed');
if (/:8486\b/.test(URL_)) throw new Error('not the manager you use: point this at a test manager');

const token = readFileSync(join(DATA, 'cli.token'), 'utf8').trim();
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(URL_ + path, { method, headers: { 'content-type': 'application/json', 'x-dither-accounts-cli': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const detail = (id: string) => api('GET', `/api/accounts/${encodeURIComponent(id)}`);

/**
 * What each kind's interaction does, in pixels of a 1280×800 screen (scaled to the real one): a sweep of the pointer
 * from one point to another and back, then clicks in turn on places that only switch what is shown.
 */
const ACTIONS: Record<string, { sweep: [number, number, number, number]; clicks: [number, number][] }> = {
  // The message list's rows; the folders Sent, Starred, Inbox.
  proton: { sweep: [700, 300, 700, 720], clicks: [[68, 340], [74, 378], [68, 262]] },
  // The left column (Friends, Nitro, Shop, Quests, the DMs); the Friends tabs All and Online.
  discord: { sweep: [220, 225, 220, 520], clicks: [[608, 180], [534, 180]] },
};

const SLOW: Condition[] = [
  { name: 'bw5rtt50', label: '5 Mbit/s, 50 ms', rateMbit: 5, rttMs: 50 },
  { name: 'bw1rtt150', label: '1 Mbit/s, 150 ms', rateMbit: 1, rttMs: 150 },
];

const until = async <T>(f: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s`);
    await Bun.sleep(250);
  }
};

/** The account's processes now: the extractor's tree as the manager lists it, and those of its screen. */
async function pidsOf(id: string): Promise<{ all: number[]; screen: number[] }> {
  const d = await detail(id);
  const roots = (d.process.tree as { pids: number[] }[]).flatMap((t) => t.pids);
  const ps = tree(roots.length ? roots : d.process.pid ? [d.process.pid] : []);
  const names = new Set(Object.values(DISPLAY_PROCS).flat());
  return { all: ps.map((p) => p.pid), screen: ps.filter((p) => names.has(progName(p))).map((p) => p.pid) };
}

/** Distinct colours in a sample of the picture: a blank or one-colour screen has a few. */
function colours(v: Viewer): number {
  const fb = v.fb!;
  const seen = new Set<number>();
  for (let i = 0; i < fb.length; i += 4 * 97) seen.add((fb[i]! << 16) | (fb[i + 1]! << 8) | fb[i + 2]!);
  return seen.size;
}
function hash(v: Viewer): number {
  let h = 0;
  const fb = v.fb!;
  for (let i = 0; i < fb.length; i += 4 * 31) h = (Math.imul(h, 31) + fb[i]! + (fb[i + 1]! << 8) + (fb[i + 2]! << 16)) | 0;
  return h;
}

/** From now: until the live view shows a drawn screen (many colours), and until that picture has held for 2 s. */
async function drawn(sock: string, t0: number, ms = 120_000): Promise<{ drawnMs: number; settledMs: number; colours: number }> {
  const end = t0 + ms;
  let drawnAt = 0;
  for (;;) {
    if (performance.now() > end) throw new Error('the live view showed no drawn screen');
    let v: Viewer;
    try {
      v = await Viewer.open(sock, { encodings: [0], keepPicture: true });
    } catch {
      await Bun.sleep(250);
      continue;
    }
    try {
      let last = 0;
      let since = 0;
      while (performance.now() < end && !v.error) {
        await Bun.sleep(100);
        if (!v.updates) continue;
        const c = colours(v);
        if (c < 40) {
          drawnAt = 0;
          continue;
        }
        drawnAt ||= performance.now();
        const h = hash(v);
        if (h !== last) [last, since] = [h, performance.now()];
        else if (performance.now() - since >= 2000) return { drawnMs: drawnAt - t0, settledMs: since - t0, colours: c };
      }
    } finally {
      v.close();
    }
  }
}

/**
 * The pointer swept over the list (`steps` moves of 40 ms each way), then each click of the kind in turn, `rounds`
 * times, 700 ms apart. Counts what the live view got meanwhile.
 */
async function interact(sock: string, kind: string, roots: () => number[], steps = 30, rounds = 3) {
  const v = await Viewer.open(sock, { encodings: novncEncodings(), mode: 'novnc' });
  try {
    await until(async () => v.updates > 0, 60_000, 'the first picture');
    const t1 = performance.now();
    await Bun.sleep(1000);
    const a = ACTIONS[kind];
    if (!a) throw new Error(`no interaction for ${kind}`);
    const sx = v.width / 1280, sy = v.height / 800;
    const at = (x: number, y: number): [number, number] => [Math.round(x * sx), Math.round(y * sy)];
    const [x0, y0, x1, y1] = a.sweep;
    v.pointer(...at(x0, y0), 0);
    await Bun.sleep(300);
    const [u0, f0, b0] = [v.updates, v.frames, v.bytes];
    v.encodings = {};
    const t0 = performance.now();
    const span = steps * 2 * 40 + rounds * a.clicks.length * 700 + 1000;
    const go = (async () => {
      for (const [f, t] of [[0, 1], [1, 0]] as const)
        for (let i = 0; i <= steps; i++) {
          const k = f + (t - f) * (i / steps);
          v.pointer(...at(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k), 0);
          await Bun.sleep(40);
        }
      for (let r = 0; r < rounds; r++)
        for (const [cx, cy] of a.clicks) {
          v.pointer(...at(cx, cy), 0);
          v.pointer(...at(cx, cy), 1);
          v.pointer(...at(cx, cy), 0);
          await Bun.sleep(700);
        }
      await Bun.sleep(1000);
    })();
    const cpu = await Promise.all([cpuOver(roots, span), go]).then(([c]) => c);
    const s = (performance.now() - t0) / 1000;
    if (v.error) throw new Error(`the viewer: ${v.error}`);
    return { firstMs: t1 - v.t.open, fps: (v.frames - f0) / s, updatesPerS: (v.updates - u0) / s, bytesPerS: (v.bytes - b0) / s, cpu: cpu.total, cpuByName: cpu.byName, encodings: v.encodings };
  } finally {
    v.close();
  }
}

/** Through a shaped link: the first whole screen, then the same interaction. */
async function slow(sock: string, kind: string, roots: () => number[], c: Condition, dir: string) {
  const link = await startLink(sock, c, dir);
  try {
    const t0 = performance.now();
    const v = await Viewer.open(link.socket, { encodings: novncEncodings(), mode: 'novnc' });
    let area = 0;
    const whole = await new Promise<number>((r, j) => {
      const t = setTimeout(() => j(new Error('no whole screen within 60 s')), 60_000);
      v.onRect = (_x, _y, w, h) => {
        area += w * h;
        if (area >= v.width * v.height) (clearTimeout(t), r(performance.now() - t0));
      };
    }).finally(() => v.close());
    const s = await interact(link.socket, kind, roots, 20, 2);
    return { firstWholeMs: whole, fps: s.fps, bytesPerS: s.bytesPerS, cpu: s.cpu };
  } finally {
    await link.stop();
  }
}

async function setBackend(id: string, backend: Backend | null) {
  await api('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { settings: { displayBackend: backend } });
}

/** One account on one backend. */
async function measure(id: string, backend: Backend, dir: string) {
  const before = await detail(id);
  const acc = before.account;
  const t0 = performance.now();
  const wall0 = Date.now();
  const loadAtStart = load1();
  await setBackend(id, backend);
  const online = await until(async () => {
    const d = await detail(id);
    return d.account.online && d.process.displayBackend === backend && (d.process.onlineSince ?? 0) >= wall0 - 1000 ? d : null;
  }, 180_000, `${acc.label} online on ${backend}`);
  const onlineMs = performance.now() - t0;
  const sock = join(acc.dir, 'vnc.sock');
  const shown = await drawn(sock, t0);
  log(`  ${acc.label} ${backend}: online ${(onlineMs / 1000).toFixed(1)} s, drawn ${(shown.drawnMs / 1000).toFixed(1)} s, settled ${(shown.settledMs / 1000).toFixed(1)} s`);
  await Bun.sleep(20_000);
  const ps = await pidsOf(id);
  const all = () => ps.all;
  const idleCpu = await cpuOver(all, 10_000);
  const map = procs();
  const mem = memory(ps.all.map((p) => map.get(p)!).filter(Boolean));
  const screenMem = memory(ps.screen.map((p) => map.get(p)!).filter(Boolean));
  const screenCpu = Object.entries(idleCpu.byName).filter(([n]) => Object.values(DISPLAY_PROCS).flat().includes(n)).reduce((a, [, c]) => a + c, 0);
  const sc = await interact(sock, acc.kind, all);
  log(`  interact ${sc.fps.toFixed(1)} fps ${(sc.bytesPerS / 1e6).toFixed(2)} MB/s cpu ${sc.cpu.toFixed(0)}%`);
  const slowRuns: Record<string, unknown> = {};
  for (const c of SLOW) {
    try {
      slowRuns[c.name] = await slow(sock, acc.kind, all, c, dir);
    } catch (e) {
      slowRuns[c.name] = { error: (e as Error).message };
    }
  }
  return {
    account: id,
    kind: acc.kind,
    label: acc.label,
    backend,
    // The machine's 1-minute load as the run began: the machine is shared, and one run is one sample.
    load: loadAtStart,
    onlineMs,
    usableMs: Math.max(onlineMs, shown.settledMs),
    drawnMs: shown.drawnMs,
    settledMs: shown.settledMs,
    colours: shown.colours,
    idle: { cpu: idleCpu.total, screenCpu, cpuByName: idleCpu.byName, pssMB: mem.pssMB, rssMB: mem.rssMB, ussMB: mem.ussMB, screenPssMB: screenMem.pssMB, screenUssMB: screenMem.ussMB },
    interact: sc,
    slow: slowRuns,
    procs: Object.fromEntries((online.process.tree as { name: string; pids: number[] }[]).map((t) => [t.name, t.pids.length])),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'da-bench-lab-'));
const runs: unknown[] = [];
const notes: { account: string; backend: string; note: string }[] = [];
const save = () => {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), backends: BACKENDS, reps: REPS, runs, notes }, null, 1));
};
try {
  for (const id of IDS) {
    const start = (await detail(id)).account;
    log(`${start.label} (${start.kind})`);
    for (let rep = FIRST_REP; rep < FIRST_REP + REPS; rep++) {
      // A different order each rep, so no backend always comes first (a warm cache, a fresh login).
      const order = BACKENDS.map((_, i) => BACKENDS[(i + rep) % BACKENDS.length]!);
      for (const b of order) {
        try {
          runs.push({ rep, ...(await measure(id, b, dir)) });
        } catch (e) {
          const note = (e as Error).message;
          log(`  ${b}: ${note}`);
          notes.push({ account: id, backend: b, note });
          // Not online: left as it is (a checkpoint, a login), nothing more on this account.
          if (/online on/.test(note)) break;
        }
        save();
      }
    }
    if (RESTORE) {
      await setBackend(id, null);
      log(`  ${start.label}: back to the manager's default`);
    }
  }
} finally {
  save();
  rmSync(dir, { recursive: true, force: true });
  log(`wrote ${OUT}`);
}
