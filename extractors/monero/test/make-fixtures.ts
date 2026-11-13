/**
 * Makes test/fixtures/monero.json from dither-finance's own puller: connectors/monero.py's pull(), unchanged, against
 * the fake wallet programs (fake-bin/, through its _bin) and a fake node, in a throwaway FINANCE_HOME, with key images
 * to import and its clock fixed at FIXED. test/monero.test.ts checks the extractor writes the same bytes.
 *
 *   bun extractors/monero/test/make-fixtures.ts [path/to/dither-finance]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADDRESS, fakeNode, FIXED, KEY_IMAGES, VIEW_KEY } from './fake-node.ts';

const ft = process.argv[2] ?? join(homedir(), 'Projects/dither-finance');
const home = mkdtempSync(join(tmpdir(), 'monero-fixture-'));
mkdirSync(join(home, 'secrets'), { mode: 0o700 });
mkdirSync(join(home, 'data'), { mode: 0o700 });
const node = fakeNode();
writeFileSync(join(home, 'secrets/monero.json'), JSON.stringify({ address: ADDRESS, view_key: VIEW_KEY, restore_height: '3300000', node: `127.0.0.1:${node.port}` }), { mode: 0o600 });
writeFileSync(join(home, 'secrets/monero_key_images'), KEY_IMAGES, { mode: 0o600 });
const [d, t] = FIXED.replace('Z', '').split('T');
const code = `
import datetime as dt, connectors.monero as m
m._bin = lambda n: ${JSON.stringify(join(import.meta.dir, 'fake-bin'))} + "/" + n
class D(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return dt.datetime(${d.split('-').map(Number).join(', ')}, ${t.split(':').map(Number).join(', ')}, tzinfo=dt.timezone.utc)
m.datetime = D
m.pull(None)
`;
const p = Bun.spawn(['uv', 'run', '--quiet', 'python', '-c', code], { cwd: ft, env: { ...process.env, FINANCE_HOME: home, FAKE_MONERO_ARGV: '1' }, stdout: 'ignore', stderr: 'pipe' });
const errText = await new Response(p.stderr).text();
node.stop(true);
if ((await p.exited) !== 0) throw new Error(`monero.py failed: ${errText.split('\n').slice(-3).join(' ')}`);
const files = readdirSync(join(home, 'data/raw'));
if (files.length !== 1) throw new Error(`expected one file, got ${files.length}`);
mkdirSync(join(import.meta.dir, 'fixtures'), { recursive: true });
writeFileSync(join(import.meta.dir, 'fixtures/monero.json'), readFileSync(join(home, 'data/raw', files[0])));
writeFileSync(join(import.meta.dir, 'fixtures/monero-name.txt'), files[0] + '\n');
rmSync(home, { recursive: true });
console.log(`${files[0]} -> fixtures/monero.json`);
