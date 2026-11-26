#!/usr/bin/env bun
/**
 * The native apps' sandboxes (packages/sandbox) on each display: Signal Desktop, Telegram Desktop and Haveno (an X
 * app, through xwayland-satellite on wayland), each on x11, on each Xvnc (tigervnc, kasmvnc), on wayland
 * with sway on the GPU (gles2) and on wayland with sway drawing in software (pixman, what they get:
 * AppSandboxOptions.gpu). No network (`none`), a fresh temporary home, never signed in: each app gets as far as its
 * first screen.
 *
 *   bun scripts/bench-native.ts [--out native.json] [--reps 3] [--apps signal,telegram,haveno] [--shots <dir>]
 *                               [--configs x11,tigervnc,kasmvnc,gles2,pixman] [--max-load <load1>] [--wait-load-s 600]
 *
 * For each: the sandbox up (screen, bus, audio), the app's first picture (a screenshot with more than a few colours),
 * then after 15 s CPU over 10 s and memory (PSS) by program, and whether input reaches it (a click on Telegram's Start
 * Messaging or Haveno's Next, then Tab pressed three times: the screenshot changes). The app's own output is read for GPU and GL
 * troubles (lines kept in the JSON on this machine only: they are the app's, never committed).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FreeDisplay, pickFreeDisplay, resolveBin } from '../packages/sandbox/src/index.ts';
import { AppSandbox, type AppSandboxOptions } from '../packages/sandbox/src/sandbox.ts';
import { AUDIO, resolveSignalDesktop } from '../extractors/signal/src/desktop/desktop.ts';
import { argOf, cpuOver, log, memory, progName, quiet, tree, work } from './bench-lib.ts';

const OUT = argOf('out', join(homedir(), '.cache/da-bench', `native-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const REPS = Number(argOf('reps', '3'));
const APPS = argOf('apps', 'signal,telegram,haveno').split(',');
const SHOTS = argOf('shots', '');
const MAX_LOAD = Number(argOf('max-load', String(cpus().length / 2)));
const WAIT_LOAD_S = Number(argOf('wait-load-s', '600'));
const W = 1280;
const H = 800;
const ALL_CONFIGS = [
  { name: 'x11', backend: 'x11' as const, gpu: false },
  { name: 'tigervnc', backend: 'tigervnc' as const, gpu: false },
  { name: 'kasmvnc', backend: 'kasmvnc' as const, gpu: false },
  { name: 'gles2', backend: 'wayland' as const, gpu: true },
  { name: 'pixman', backend: 'wayland' as const, gpu: false },
  // sway as for native apps (pixman), with TigerVNC's w0vncserver as the live view.
  { name: 'w0-pixman', backend: 'wayland-tigervnc' as const, gpu: false },
];
const WANT = argOf('configs', ALL_CONFIGS.map((c) => c.name).join(',')).split(',');
const CONFIGS = ALL_CONFIGS.filter((c) => WANT.includes(c.name));
const SCREEN_PROCS = ['Xvfb', 'x11vnc', 'Xvnc', 'Xkasmvnc', 'sway', 'wayvnc', 'w0vncserver', 'xwayland-satellite', 'Xwayland'];
/** A program of the screen stack, by its name in /proc, which the kernel cuts to 15 characters (xwayland-satel). */
const screenProc = (name: string) => SCREEN_PROCS.some((p) => p.startsWith(name) && name.length >= Math.min(p.length, 14));
const GPU_LINE = /\b(EGL|GLX|GLES|OpenGL|gbm|DRI\d?|dri|GPU|gpu_|vaapi|libva|ContextLost|context lost|swrast|llvmpipe|zink|vulkan|Vulkan|SwiftShader|ANGLE|viz|Skia)\b/;

type App = { name: string; opts: (dir: string) => Partial<AppSandboxOptions> & Pick<AppSandboxOptions, 'command'>; click?: [number, number] };
const noLog = () => {};
const APP_DEFS: Record<string, App> = {
  signal: {
    name: 'Signal Desktop',
    opts: () => {
      const { electron, asar } = resolveSignalDesktop(noLog);
      return { command: [electron, asar, '--password-store=basic'], env: { ELECTRON_FORCE_IS_PACKAGED: '1' }, audio: AUDIO, fitWindow: 'Signal' };
    },
  },
  telegram: {
    name: 'Telegram Desktop',
    opts: () => ({ command: [resolveBin({ name: 'Telegram', env: 'TELEGRAM_DESKTOP_BIN', nix: 'telegram-desktop' }, noLog), '-workdir', '/home/user/.local/share/TelegramDesktop', '-noupdate'], fitWindow: '^Telegram' }),
    // Start Messaging, in the middle of the fitted window.
    click: [640, 505],
  },
  haveno: {
    name: 'Haveno',
    opts: (dir) => {
      const data = join(dir, 'haveno-data');
      mkdirSync(data, { recursive: true });
      return { command: [resolveBin({ name: 'haveno-desktop', env: 'HAVENO_DESKTOP_BIN', nix: 'haveno-desktop' }, noLog)], roBinds: ['/lib64'], binds: [{ src: data, dest: '.local/share/Haveno-reto' }], x11App: true, fitWindow: '^Haveno' };
    },
    // Next, on the first page of its own introduction (it only turns the page).
    click: [944, 644],
  },
};

const magick = resolveBin({ name: 'magick', env: 'MAGICK_BIN', nix: 'imagemagick' }, noLog);
const colours = (png: Buffer) => Number(Bun.spawnSync([magick, 'png:-', '-format', '%k', 'info:'], { stdin: png }).stdout.toString().trim() || 0);
/** How much of the screen is drawn: its mean brightness, 0 (black) to 1. */
const brightness = (png: Buffer) => Number(Bun.spawnSync([magick, 'png:-', '-format', '%[fx:mean]', 'info:'], { stdin: png }).stdout.toString().trim() || 0);
const differ = (a: Buffer, b: Buffer, dir: string) => {
  const fa = join(dir, 'a.png');
  const fb = join(dir, 'b.png');
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  const p = Bun.spawnSync([magick, 'compare', '-metric', 'AE', fa, fb, 'null:'], { stderr: 'pipe' });
  return Number(p.stderr.toString().trim().split(/\s/)[0] || 0);
};

async function one(app: App, key: string, cfg: (typeof CONFIGS)[number], rep: number) {
  const dir = mkdtempSync(join(work(), `${key}-${cfg.name}-`));
  const lines: string[] = [];
  const log_ = (level: string, msg: string, extra?: unknown) => {
    if (msg.startsWith('[app]')) lines.push(msg.slice(6));
    else if (level === 'warn' || level === 'error') lines.push(`(${level}) ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
  };
  const display: FreeDisplay = cfg.backend === 'wayland' || cfg.backend === 'wayland-tigervnc' ? { backend: cfg.backend, display: null } : await pickFreeDisplay(undefined, [], cfg.backend);
  const sb = new AppSandbox({ dir: join(dir, 'desktop'), display, width: W, height: H, network: 'none', gpu: cfg.gpu, log: log_ as any, onEvent: () => {}, ...app.opts(dir) });
  const out: any = { app: key, config: cfg.name, rep };
  const roots = () => ((sb as any).procs ?? []).map((p: { proc: { pid: number } }) => p.proc.pid);
  try {
    const t0 = performance.now();
    await sb.start();
    out.sandboxMs = performance.now() - t0;
    out.backend = sb.info().backend;
    // The first picture: more than a handful of colours on the screen, and more of it than a pointer on black (on
    // wayland-tigervnc sway draws the pointer into the output from the start: about 40 colours on an empty screen).
    const end = Date.now() + 90_000;
    let shot: Buffer | null = null;
    for (;;) {
      shot = Buffer.from(await sb.screen!.screenshot());
      const k = colours(shot);
      if (k > 16 && brightness(shot) > 0.02) {
        out.firstPictureMs = performance.now() - t0;
        out.colours = k;
        break;
      }
      if (Date.now() > end) {
        out.firstPictureMs = null;
        out.colours = k;
        break;
      }
      await Bun.sleep(250);
    }
    await Bun.sleep(15_000);
    const cpu = await cpuOver(roots, 10_000);
    const all = tree(roots());
    const byName: Record<string, number> = {};
    for (const p of all) byName[progName(p)] = (byName[progName(p)] ?? 0) + memory([p]).pssMB;
    const screenPss = Object.entries(byName).filter(([n]) => screenProc(n)).reduce((a, [, v]) => a + v, 0);
    out.idle = { cpu: cpu.total, cpuByName: cpu.byName, pssMB: memory(all).pssMB, screenPssMB: screenPss, appPssMB: memory(all).pssMB - screenPss, pssByName: byName };
    // Input.
    const before = Buffer.from(await sb.screen!.screenshot());
    if (app.click) await sb.screen!.click(app.click[0], app.click[1]);
    await sb.screen!.keys(['Tab', 'Tab', 'Tab']);
    await Bun.sleep(3000);
    const after = Buffer.from(await sb.screen!.screenshot());
    out.input = { changedPixels: differ(before, after, dir), coloursAfter: colours(after) };
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, `${key}-${cfg.name}-${rep}-1.png`), before);
      writeFileSync(join(SHOTS, `${key}-${cfg.name}-${rep}-2.png`), after);
    }
    out.appState = sb.info().app;
    out.appExits = sb.info().appExits;
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    await sb.stop().catch(() => {});
    out.gpuLines = lines.filter((l) => GPU_LINE.test(l)).slice(0, 30);
    out.logLines = lines.length;
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

process.env.DITHER_SANDBOX_APP_LOG = '1';
const results: any = { when: new Date().toISOString(), machine: { cpus: cpus().length, model: cpus()[0]?.model }, size: `${W}x${H}`, reps: REPS, maxLoad: MAX_LOAD, runs: [] as any[] };
const save = () => {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
};
try {
  for (let rep = 0; rep < REPS; rep++)
    for (const key of APPS) {
      const order = CONFIGS.map((_, i) => CONFIGS[(i + rep) % CONFIGS.length]!);
      for (const cfg of order) {
        const load = await quiet(MAX_LOAD, WAIT_LOAD_S);
        log(`rep ${rep + 1}/${REPS} ${key} ${cfg.name} (load ${load.load.toFixed(1)}${load.busy ? ', busy' : ''})`);
        const r = await one(APP_DEFS[key]!, key, cfg, rep);
        r.load = load;
        log(`  ${JSON.stringify({ ...r, gpuLines: r.gpuLines?.length, idle: r.idle && { cpu: r.idle.cpu, pssMB: r.idle.pssMB, screenPssMB: r.idle.screenPssMB } }).slice(0, 400)}`);
        results.runs.push(r);
        save();
      }
    }
} finally {
  save();
  rmSync(work(), { recursive: true, force: true });
  log(`wrote ${OUT}`);
}
process.exit(0);
