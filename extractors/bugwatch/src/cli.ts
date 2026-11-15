/**
 * bugwatch by hand, without the manager:
 *
 *   bun extractors/bugwatch/src/cli.ts --config <file> --dry [--since 24h]
 *       reads the sources now (the last 24 h, or --since) and prints the bugs it would raise and the threads it would
 *       start; it starts nothing and writes nothing.
 *   bun extractors/bugwatch/src/cli.ts --config <file> --selftest [--source <name>]
 *       starts one thread with the config's thread command (the first source with a project, or --source) whose
 *       only task is to reply "ok", and prints what the command answered.
 *   bun extractors/bugwatch/src/cli.ts --account-dir <dir> --clear <bug id>
 *       clears a fingerprint of a running bugwatch account (it may get a thread again); applied at its next scan.
 *   bun extractors/bugwatch/src/cli.ts --account-dir <dir> --report [--days 7]
 *       the threads a running bugwatch account started in the last days, and what each cost as far as threads.show said.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { run } from './run.ts';
import { DAY, fresh, HOUR, loadState } from './state.ts';
import { parseThreadId, type RunResult, Watch } from './watch.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (m: string): never => {
  console.error(m);
  process.exit(2);
};
const TEMPLATE = readFileSync(join(import.meta.dir, '../brief.md'), 'utf8');

function since(s: string | undefined): number {
  if (!s) return DAY;
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(s);
  if (!m) return die(`--since takes 30m, 6h or 2d, not "${s}"`);
  return Number(m[1]) * { m: 60_000, h: HOUR, d: DAY }[m[2] as 'm' | 'h' | 'd'];
}

if (flag('clear')) {
  const dir = value('account-dir') ?? die('--clear needs --account-dir <the bugwatch account directory>');
  const id = value('clear') ?? die('--clear needs a bug id');
  appendFileSync(join(dir, 'clear.txt'), `${id}\n`, { mode: 0o600 });
  console.log(`${id} goes in ${join(dir, 'clear.txt')}; the account applies it at its next scan.`);
  process.exit(0);
}

if (flag('report')) {
  const dir = value('account-dir') ?? die('--report needs --account-dir <the bugwatch account directory>');
  const days = Number(value('days') ?? 7);
  if (!(days > 0)) die('--days takes a number of days');
  const st = loadState(join(dir, 'state.json'), (m) => die(m));
  const now = Date.now();
  const bugs = Object.values(st.bugs).filter((b) => b.thread && b.thread.at >= now - days * DAY).sort((a, b) => a.thread!.at - b.thread!.at);
  for (const b of bugs) {
    const t = b.thread!;
    const r = t.record;
    const cost = t.failed ? `failed to start (${t.failed})` : !r || r.runs === undefined ? (r?.error ? `not read: ${r.error}` : 'no record yet') : `${r.status ?? '?'}${r.done ? ', done' : ''}: ${r.runs} runs, ${r.items ?? '?'} items, ${r.prs ?? 0} PRs, ${r.minutes ?? '?'} min`;
    console.log(`${new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')}  ${t.title}\n    bug ${b.id}, seen ${b.count} times; ${cost}${t.id ? `; thread ${t.id}` : ''}`);
  }
  const w = new Watch({ sources: [], ignore: [], always: [], threads: null, briefs: [], spikeGapHours: 6 }, st, { now: () => now, run: async () => ({ code: null, stdout: '', stderr: '' }), log: () => {}, emit: () => {}, briefTemplate: '' });
  const r = w.report(days, now);
  console.log(`\nthe last ${days} days: ${r.threads} threads (${r.withPr} with a PR, ${r.unknown} without a record), ${r.failed} failed to start; ${r.runs} runs, ${r.items} items, ${r.minutes} min in all`);
  process.exit(0);
}

const configPath = value('config') ?? die('usage: cli.ts --config <file> (--dry [--since 24h] | --selftest [--source <name>]), or --account-dir <dir> (--clear <id> | --report [--days 7])');
const cfg = (() => {
  try {
    return loadConfig(configPath);
  } catch (e) {
    return die((e as Error).message);
  }
})();

if (flag('selftest')) {
  if (!cfg.threads) die('the config has no threads.command');
  const name = value('source');
  const src = name ? cfg.sources.find((s) => s.name === name) : cfg.sources.find((s) => s.project && s.base);
  if (!src?.project || !src.base) die(name ? `source "${name}" names no project and base` : 'no source names a project and a base');
  const argv = cfg.threads!.command.map((a) => a.replaceAll('{title}', 'bugwatch selftest').replaceAll('{project}', src!.project!).replaceAll('{base}', src!.base!));
  console.log(`running: ${JSON.stringify(argv)}`);
  const r = await run(argv, 'This is a test of the bugwatch thread command. Reply with only the word ok. Do not read, run or change anything.\n', 120_000);
  console.log(`exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
  if (r.stdout.trim()) console.log(`stdout: ${r.stdout.trim()}`);
  if (r.stderr.trim()) console.log(`stderr: ${r.stderr.trim()}`);
  const id = r.code === 0 ? parseThreadId(r.stdout) : null;
  console.log(id ? `thread id: ${id}` : 'no thread id in its output');
  process.exit(r.code === 0 && id ? 0 : 1);
}

if (!flag('dry')) die('nothing to do: pass --dry or --selftest');

// A dry run: a fresh state, the window given, a thread command that only says what it would have run.
const window = since(value('since'));
const now = Date.now();
const st = fresh();
const started: { title: string; argv: string[] }[] = [];
const w = new Watch(cfg, st, {
  now: () => now,
  run: async (argv): Promise<RunResult> => {
    started.push({ title: argv.join(' '), argv });
    return { code: 0, stdout: JSON.stringify({ threadId: '(dry run)' }), stderr: '' };
  },
  log: (level, m) => level !== 'info' && console.error(`[${level}] ${m}`),
  emit: () => {},
  briefTemplate: TEMPLATE,
});
w.backlogMs = window;
const r = await w.scan();
console.log(`${r.records} records in the last ${value('since') ?? '24h'} of ${cfg.sources.length} sources; ${r.raised.length} bugs it would raise:\n`);
for (const { bug, reason } of r.raised) {
  const n = w.notification(bug);
  console.log(`${n.urgency === 'high' ? '!' : '-'} [${reason}] ${n.title}\n    ${n.body}\n    fingerprint ${bug.id}: ${bug.text}\n`);
}
for (const s of cfg.sources) {
  const h = w.health.get(s.name);
  console.log(`source ${s.name}: ${h ? (h.error ? `failed: ${h.error}` : `${h.files} files, ${h.records} records`) : 'not read'}`);
}
console.log('\nhow far back each source goes:');
for (const x of w.reach()) console.log(`  ${x.name}: ${x.from === null ? 'no dated line' : new Date(x.from).toISOString()} (${x.files} files)`);
if (cfg.threads) {
  console.log(`\nthreads (one every ${cfg.threads.gapMinutes} min, ${cfg.threads.dayMax} a day; a new bug that is not a crash waits until it is seen again ${cfg.threads.recurMinutes} min after its first sighting):`);
  for (const s of started) console.log(`  would start now: ${JSON.stringify(s.argv)}`);
  for (const b of Object.values(st.bugs).filter((x) => x.held)) console.log(`  held until it comes back: ${w.threadTitle(b)} (${b.count} times over ${Math.round((b.last - b.first) / 60_000)} min)`);
  for (const b of w.queue()) console.log(`  would queue: ${w.threadTitle(b)} (${b.count} times)`);
  const first = Object.values(st.bugs).find((b) => b.thread);
  if (first && flag('brief')) console.log(`\nits brief:\n\n${w.brief(first)}`);
} else console.log('\nno threads: the config has no threads.command');
