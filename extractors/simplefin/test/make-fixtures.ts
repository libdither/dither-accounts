/**
 * Makes test/fixtures from dither-finance's own puller: runs simplefin/sfin.py (stdlib Python, unchanged) against
 * the fake bridge in a throwaway FINANCE_HOME, and keeps what it wrote (sfin-w<i>.json) and the windows it asked for,
 * relative to its own clock (windows.json). test/simplefin.test.ts checks the extractor writes the same bytes.
 *
 *   bun extractors/simplefin/test/make-fixtures.ts [path/to/sfin.py]   # default ~/Projects/dither-finance/simplefin/sfin.py
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { FakeBridge } from './fake-bridge.ts';

const sfin = process.argv[2] ?? join(homedir(), 'Projects/dither-finance/simplefin/sfin.py');
const out = join(import.meta.dir, 'fixtures');
const home = mkdtempSync(join(tmpdir(), 'sfin-fixture-'));
mkdirSync(join(home, 'secrets'), { mode: 0o700 });
const fake = new FakeBridge().start();
writeFileSync(join(home, 'secrets/simplefin_access_url'), fake.accessUrl, { mode: 0o600 });
const py = Bun.which('python3') ?? Bun.which('python');
if (!py) throw new Error('no python');
// Async: the fake bridge answers from this process's event loop.
const p = Bun.spawn([py, sfin, 'pull', '--days', '100'], { env: { ...process.env, FINANCE_HOME: home }, stdout: 'ignore', stderr: 'ignore' });
await p.exited;
fake.stop();
if (p.exitCode !== 0) throw new Error(`sfin.py exited ${p.exitCode}`);
const files = readdirSync(join(home, 'data/raw')).sort();
mkdirSync(out, { recursive: true });
for (const f of files) {
  const i = f.match(/-w(\d+)\.json$/)![1];
  writeFileSync(join(out, `sfin-w${i}.json`), readFileSync(join(home, 'data/raw', f)));
}
const now = Number(fake.requests[0].query['end-date']) - 86400;
const windows = fake.requests.map((r) => ({ keys: Object.keys(r.query), start: Number(r.query['start-date']) - now, end: Number(r.query['end-date']) - now }));
writeFileSync(join(out, 'windows.json'), JSON.stringify({ days: 100, names: files.map((f) => f.replace(/\d{8}T\d{6}/, 'STAMP')), windows }, null, 1) + '\n');
rmSync(home, { recursive: true });
console.log(`${files.length} file(s), ${windows.length} request(s) -> ${out}`);
