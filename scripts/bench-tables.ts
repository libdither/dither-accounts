#!/usr/bin/env bun
/**
 * The benchmarks' numbers as Markdown tables, for a dated page under docs/benchmarks/: each cell is the range over
 * the repetitions (lowest–highest), never a median of a few, from the JSON that scripts/bench-display.ts,
 * bench-link.ts and bench-native.ts write. Several files of one kind are merged by putting their runs together
 * (each run keeps the backend and repetition it had), so a session run in parts, or one backend measured again, makes
 * one table; the page says which files it came from.
 *
 *   bun scripts/bench-tables.ts [--results a.json,b.json] [--scale scale.json] [--link link.json] [--native native.json]
 *                               [--lab lab.json] [--backends x11,tigervnc,...]
 *
 * Only numbers and backend names come out: a lab run's account and label stay in its JSON.
 */
import { readFileSync } from 'node:fs';
import { argOf } from './bench-lib.ts';

const files = (name: string) => argOf(name, '').split(',').filter(Boolean);
const load = (name: string) => files(name).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const merged = (name: string, key = 'runs') => load(name).flatMap((d) => d[key] ?? []);
const results = merged('results');
const scale = [...merged('scale', 'scale'), ...merged('results', 'scale')];
const link = load('link');
const linkRuns = link.flatMap((d) => d.runs);
const native = merged('native');
const lab = merged('lab');
const order = argOf('backends', '').split(',').filter(Boolean);
const backendsOf = (runs: { backend: string }[]) => {
  const seen = [...new Set(runs.map((r) => r.backend))];
  return order.length ? order.filter((b) => seen.includes(b)) : seen;
};

const num = (f: () => unknown) => {
  try {
    const v = f();
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
};
const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString('en') : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 2 : 2).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m)));
/** "12–15", or "12" when every repetition gave the same, or "–" with none. */
function range(vs: number[]) {
  if (!vs.length) return '–';
  const lo = fmt(Math.min(...vs));
  const hi = fmt(Math.max(...vs));
  return lo === hi ? lo : `${lo}–${hi}`;
}
const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
function table(head: string[], rows: string[][]) {
  return [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
}
type Metric<R> = [string, (r: R) => unknown, ...((r: R) => unknown)[]];
/** One row per metric, one column per backend; a metric with several getters shows "a, b" from the same runs. */
function byBackend<R extends { backend: string }>(runs: R[], metrics: Metric<R>[]) {
  const bs = backendsOf(runs);
  return table(
    ['', ...bs.map((b) => `\`${b}\``)],
    metrics.map(([label, ...gets]) => [label, ...bs.map((b) => gets.map((g) => range(runs.filter((r) => r.backend === b).flatMap((r) => num(() => g(r)) ?? []))).join(', '))]),
  );
}
const loads = (runs: any[]) => range(runs.flatMap((r) => num(() => r.load.load) ?? []));
const MB = 1e6;
const out: string[] = [];

if (results.length) {
  const displayPss = (r: any) => Object.entries(r.idle.memByName as Record<string, { pssMB: number }>).filter(([k]) => k !== 'chromium').reduce((n, [, v]) => n + v.pssMB, 0);
  out.push(`Synthetic pages (scripts/bench-display.ts): ${new Set(results.map((r) => r.rep)).size} repetitions per backend, 1-minute load ${loads(results)} as each began.\n`);
  out.push(
    byBackend(results, [
      ['start → live view answers RFB (ms)', (r) => r.start.screenMs],
      ['start → first page ran (ms)', (r) => r.start.pageMs],
      ['idle: display programs, PSS (MB)', displayPss],
      ['idle: the sandbox, USS (MB)', (r) => r.idle.ussMB],
      ['idle: CPU (% of a core)', (r) => r.idle.cpu],
      ['animation, ZRLE: frames/s, server CPU %', (r) => r.vnc.anim.fps, (r) => r.vnc.anim.serverCpu],
      ['animation, Tight: frames/s, MB/s, server CPU %', (r) => r.vnc.animTight.fps, (r) => r.vnc.animTight.bytesPerS / MB, (r) => r.vnc.animTight.serverCpu],
      ['scrolling, Tight: frames/s, MB/s', (r) => r.vnc.scrollTight.fps, (r) => r.vnc.scrollTight.bytesPerS / MB],
      ['720p video, Tight: frames/s, MB/s', (r) => r.vnc.videoTight.fps, (r) => r.vnc.videoTight.bytesPerS / MB],
      ['RFB press → page handler (ms, median of 20)', (r) => r.input.toHandler.median],
      ['click to photon (ms, median of 20)', (r) => r.input.clickToPhoton.median],
      ['typing, 35 ms a key (chars/s)', (r) => r.typing.charsPerS],
      ['screen share: frames/s, drawn → decoded ms, CPU %', (r) => r.share.fps, (r) => r.share.latencyP50, (r) => r.share.cpu],
      ['720p VP9 in Chromium: dropped %, CPU %', (r) => r.video.droppedPct, (r) => r.video.cpu],
      ['WebGL: frames/s, CPU %', (r) => r.webgl.fps, (r) => r.webgl.cpu],
      ['screenshot (ms, median of 10)', (r) => r.shot.median],
    ]),
  );
}

if (scale.length) {
  const ns = [...new Set(scale.map((s) => s.n as number))].sort((a, b) => a - b);
  const bs = backendsOf(scale);
  out.push(`\nSandboxes started at once (bench-display.ts --only scale): all started (s), then USS per sandbox (MB) and System V shm segments held by all of them; one run each.\n`);
  out.push(
    table(
      ['at once', ...bs.map((b) => `\`${b}\``)],
      ns.map((n) => [
        String(n),
        ...bs.map((b) => {
          const s = scale.filter((x) => x.backend === b && x.n === n);
          return s.length ? `${range(s.map((x) => x.wallMs / 1000))} s, ${range(s.map((x) => x.ussMB / n))} MB, ${range(s.map((x) => x.shm?.sandboxes ?? NaN).filter(Number.isFinite))} shm` : '–';
        }),
      ]),
    ),
  );
}

if (linkRuns.length) {
  const conds: { name: string; label: string }[] = link[0].conditions;
  const bs = backendsOf(linkRuns);
  out.push(`\nThe live view through a shaped link (scripts/bench-link.ts, as noVNC asks: Tight first, quality 6): frames/s of the animation / of the video, then click to photon (ms); ${new Set(linkRuns.map((r) => r.rep)).size} repetitions, 1-minute load ${loads(linkRuns)}.\n`);
  out.push(
    table(
      ['link', ...bs.map((b) => `\`${b}\``)],
      conds
        .filter((c) => linkRuns.some((r) => r.condition === c.name))
        .map((c) => [
          c.label,
          ...bs.map((b) => {
            const rs = linkRuns.filter((r) => r.condition === c.name && r.backend === b);
            const g = (f: (r: any) => unknown) => range(rs.flatMap((r) => num(() => f(r)) ?? []));
            return rs.length ? `${g((r) => r.anim.fps)} / ${g((r) => r.video.fps)}, ${g((r) => r.click.clickToPhoton.median)} ms` : '–';
          }),
        ]),
    ),
  );
  const base = linkRuns.filter((r) => r.condition === 'base');
  out.push(`\nBytes on an unlimited link: the first whole screen of a still page of text (KB), and the animation (MB/s).\n`);
  out.push(byBackend(base, [['first whole screen (KB)', (r) => r.first.bytes / 1000], ['animation (MB/s)', (r) => r.anim.bytesPerS / MB]]));
}

if (native.length) {
  const configs = [...new Set(native.map((r) => r.config as string))];
  const apps = [...new Set(native.map((r) => r.app as string))];
  out.push(`\nNative apps, never signed in (scripts/bench-native.ts): the display programs' memory (PSS, MB), then start → the app's first picture (s); ${new Set(native.map((r) => r.rep)).size} repetitions.\n`);
  out.push(
    table(
      ['', ...configs.map((c) => `\`${c}\``)],
      apps.map((a) => [
        a,
        ...configs.map((c) => {
          const rs = native.filter((r) => r.app === a && r.config === c && !r.error);
          return rs.length ? `${range(rs.flatMap((r) => num(() => r.idle.screenPssMB) ?? []))} MB, ${range(rs.flatMap((r) => num(() => r.firstPictureMs / 1000) ?? []))} s` : '–';
        }),
      ]),
    ),
  );
  const broken = native.filter((r) => r.error || !(r.input?.changedPixels > 0));
  out.push(`\nInput reached the app in ${native.length - broken.length} of ${native.length} runs${broken.length ? ` (not: ${broken.map((r) => `${r.app} on ${r.config}`).join(', ')})` : ''}.`);
}

if (lab.length) {
  out.push(`\nSigned-in test accounts in the lab (scripts/bench-lab.ts, read-only): ${new Set(lab.map((r) => r.account)).size} accounts (${[...new Set(lab.map((r) => r.kind))].join(', ')}), ${new Set(lab.map((r) => r.rep)).size} run(s) each, 1-minute load ${range(lab.flatMap((r) => num(() => r.load) ?? []))}; ranges over the accounts.\n`);
  out.push(
    byBackend(lab, [
      ['pointer sweep and clicks: frames/s, MB/s', (r) => r.interact.fps, (r) => r.interact.bytesPerS / MB],
      ['5 Mbit/s, 50 ms: frames/s', (r) => r.slow.bw5rtt50.fps],
      ['1 Mbit/s, 150 ms: frames/s, first whole screen (s)', (r) => r.slow.bw1rtt150.fps, (r) => r.slow.bw1rtt150.firstWholeMs / 1000],
      ['display programs, PSS (MB)', (r) => r.idle.screenPssMB],
      ['start → account online (s)', (r) => r.onlineMs / 1000],
    ]),
  );
}

console.log(out.join('\n'));
