/**
 * Makes test/fixtures from dither-finance's own puller: runs connectors/amazon.py and amazon_auth.py (unchanged: their
 * source read and run with the fake's origin and a throwaway DevTools port in place of www.amazon.com and the desk's
 * 9262, and no pauses) against the fake Amazon in a throwaway FINANCE_HOME whose secrets/amazon.json holds the fake's
 * email and password: a first pull (the backfill, with Amazon asking for the password again on the third details
 * page), then, after a new order, a daily pull. Keeps both files (pulled_at as STAMP) and the pages each visited; plus
 * amazon.py's `_money` and `_day` on a set of strings. The DevTools Chromium is test tooling for running the old
 * puller; the extractor never uses one.
 *
 *   bun extractors/amazon/test/make-fixtures.ts [~/Projects/dither-finance]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { portInUse } from '../../../packages/browser/src/display.ts';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { EMAIL, PASSWORD, startFakeAmazon } from './fake-amazon.ts';
import { DAYS, MONEYS } from './helper-cases.ts';

const FT = process.argv[2] ?? join(homedir(), 'Projects/dither-finance');
const out = join(import.meta.dir, 'fixtures');
const home = mkdtempSync(join(tmpdir(), 'amazon-fixture-'));
const prof = mkdtempSync(join(tmpdir(), 'amazon-fixture-prof-'));
mkdirSync(join(home, 'secrets'), { mode: 0o700 });
writeFileSync(join(home, 'secrets/amazon.json'), JSON.stringify({ email: EMAIL, password: PASSWORD }), { mode: 0o600 });
const fake = startFakeAmazon();
let cdp = 9450;
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
import argparse, json, sys
sys.path.insert(0, ${JSON.stringify(FT)})
src = open(${JSON.stringify(join(FT, 'connectors/amazon.py'))}).read()
src = src.replace('BASE = "https://www.amazon.com"', 'BASE = "' + sys.argv[2] + '"').replace('CDP = "http://127.0.0.1:9262"', 'CDP = "' + sys.argv[3] + '"')
src = src.replace("from .amazon_auth import", "from connectors.amazon_auth import")
ns = {"__name__": "amazon_fixture"}
exec(compile(src, "amazon.py", "exec"), ns)
ns["_desk_up"] = lambda: False
ns["_pause"] = lambda *a, **k: None
if sys.argv[1] == "pull":
    ns["pull"](argparse.Namespace(backfill=False, details=25))
else:
    cases = json.loads(sys.argv[4])
    print(json.dumps({"money": [ns["_money"](s) for s in cases["money"]], "day": [ns["_day"](s) for s in cases["day"]]}))
`;
const run = async (...args: string[]) => {
  const p = Bun.spawn(['uv', 'run', '--project', FT, 'python', '-c', PY, ...args], { cwd: FT, env: { ...process.env, FINANCE_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`amazon.py exited ${code}: ${e.slice(-800)}`);
  return o;
};
const raw = join(home, 'data/raw/amazon');
const take = (name: string, before: Set<string>) => {
  const fresh = readdirSync(raw).filter((f) => !before.has(f));
  if (fresh.length !== 1) throw new Error(`expected one new file, got ${fresh.length}`);
  const body = readFileSync(join(raw, fresh[0]), 'utf8');
  const stamp = fresh[0].slice('amazon-'.length, -'.json'.length);
  writeFileSync(join(out, name), body.replace(`"pulled_at": "${stamp}"`, '"pulled_at": "STAMP"'));
  return { file: fresh[0].replace(stamp, 'STAMP'), stampOk: /^\d{8}T\d{6}Z$/.test(stamp) };
};
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
fake.reauthAt(3);
await run('pull', fake.origin, `http://127.0.0.1:${cdp}`);
const run1 = take('run1.json', new Set());
const log1 = fake.log.splice(0);
const had = new Set(readdirSync(raw));
fake.addOrder();
await run('pull', fake.origin, `http://127.0.0.1:${cdp}`);
const run2 = take('run2.json', had);
const log2 = fake.log.splice(0);
const helpers = JSON.parse(await run('helpers', fake.origin, 'x', JSON.stringify({ money: MONEYS, day: DAYS })));
writeFileSync(join(out, 'meta.json'), JSON.stringify({ run1, log1, run2, log2 }, null, 1) + '\n');
writeFileSync(join(out, 'helpers.json'), JSON.stringify(helpers, null, 1) + '\n');
chromium.kill();
fake.stop();
rmSync(home, { recursive: true, force: true });
rmSync(prof, { recursive: true, force: true });
console.log(`run1: ${log1.length} page(s); run2: ${log2.length} page(s) -> ${out}`);
