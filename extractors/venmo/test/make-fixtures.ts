/**
 * Makes test/fixtures from dither-finance's own puller: runs connectors/venmo.py (unchanged, its source read and run
 * with the fake's origin and a throwaway DevTools port in place of account.venmo.com and the desk's 9261) against the
 * fake Venmo in a throwaway FINANCE_HOME, twice: a first pull (the backfill), then, after one more row lands in this
 * month, a daily pull. Keeps the files it wrote (names with the stamp as STAMP), the requests it made, and the day it
 * ran; plus venmo.py's `_ranges` for a set of days, with and without files and `--since`. The DevTools Chromium is test
 * tooling for running the old puller; the extractor never uses one.
 *
 *   bun extractors/venmo/test/make-fixtures.ts [~/Projects/dither-finance]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { portInUse } from '../../../packages/browser/src/display.ts';
import { iso } from '../src/venmo.ts';
import { startFakeVenmo } from './fake-venmo.ts';

const FT = process.argv[2] ?? join(homedir(), 'Projects/dither-finance');
const out = join(import.meta.dir, 'fixtures');
const home = mkdtempSync(join(tmpdir(), 'venmo-fixture-'));
const prof = mkdtempSync(join(tmpdir(), 'venmo-fixture-prof-'));
const fake = startFakeVenmo();
let cdp = 9400;
while (await portInUse(cdp, '127.0.0.1')) cdp++;
const chromium = Bun.spawn([resolveBins(() => {}).chromium, '--headless=new', `--user-data-dir=${prof}`, `--remote-debugging-port=${cdp}`, '--no-first-run', `${fake.origin}/test-login`], { stdout: 'ignore', stderr: 'ignore' });
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${cdp}/json/version`)).ok) break;
  } catch {}
  await Bun.sleep(200);
}
await Bun.sleep(1500);

const PY = `
import argparse, datetime as real, json, sys
sys.path.insert(0, ${JSON.stringify(FT)})
src = open(${JSON.stringify(join(FT, 'connectors/venmo.py'))}).read()
src = src.replace("https://account.venmo.com", sys.argv[2]).replace('CDP = "http://127.0.0.1:9261"', 'CDP = "' + sys.argv[3] + '"')
ns = {"__name__": "venmo_fixture"}
exec(compile(src, "venmo.py", "exec"), ns)
ns["_desk_up"] = lambda: False
if sys.argv[1] == "pull":
    ns["pull"](argparse.Namespace(since=None))
else:
    out = []
    for day in json.loads(sys.argv[4]):
        class D(real.date):
            @classmethod
            def today(cls):
                return real.date.fromisoformat(day)
        class DT:
            date = D; timedelta = real.timedelta; datetime = real.datetime; timezone = real.timezone
        ns["dt"] = DT
        for have in (False, True):
            for since in (None, 2021):
                r = ns["_ranges"](since, {("x", "y"): "z"} if have else {})
                out.append({"day": day, "have": have, "since": since, "ranges": [[s.isoformat(), e.isoformat(), b] for s, e, b in r]})
    print(json.dumps(out))
`;
const run = async (...args: string[]) => {
  const p = Bun.spawn(['uv', 'run', '--project', FT, 'python', '-c', PY, ...args], { cwd: FT, env: { ...process.env, FINANCE_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`venmo.py: ${e.slice(-500)}`);
  return o;
};
const today = iso(new Date());
const raw = join(home, 'data/raw/venmo');
const take = (dir: string, before: Set<string>) => {
  mkdirSync(join(out, dir), { recursive: true });
  const names: string[] = [];
  for (const f of readdirSync(raw).sort()) {
    if (before.has(f)) continue;
    const name = f.replace(/_\d{8}T\d{6}Z\.csv$/, '_STAMP.csv');
    writeFileSync(join(out, dir, name), readFileSync(join(raw, f)));
    names.push(name);
  }
  return names;
};
rmSync(out, { recursive: true, force: true });
await run('pull', fake.origin, `http://127.0.0.1:${cdp}`);
const run1 = take('run1', new Set());
const req1 = fake.requests.splice(0).map((r) => [r.start, r.end, r.ok]);
const had = new Set(readdirSync(raw));
fake.bump(today);
await run('pull', fake.origin, `http://127.0.0.1:${cdp}`);
const run2 = take('run2', had);
const req2 = fake.requests.splice(0).map((r) => [r.start, r.end, r.ok]);
const days = ['2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28', '2024-02-29', '2026-03-15', '2026-11-09', '2026-12-31'];
const ranges = JSON.parse(await run('ranges', fake.origin, 'x', JSON.stringify(days)));
writeFileSync(join(out, 'meta.json'), JSON.stringify({ today, run1, req1, run2, req2, bumped: today }, null, 1) + '\n');
writeFileSync(join(out, 'ranges.json'), JSON.stringify(ranges, null, 1) + '\n');
chromium.kill();
fake.stop();
rmSync(home, { recursive: true, force: true });
rmSync(prof, { recursive: true, force: true });
console.log(`run1: ${run1.length} file(s), ${req1.length} request(s); run2: ${run2.length} file(s), ${req2.length} request(s); ${ranges.length} range cases -> ${out}`);
