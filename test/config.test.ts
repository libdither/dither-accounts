// main.ts reads its settings from flags, then DITHER_ACCOUNTS_*, then <data>/config.toml, then its defaults.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dir, '../packages/manager/src/main.ts');
const dirs: string[] = [];
const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Starts main.ts on a fresh data dir holding `toml` as config.toml; returns its first line of output. */
async function start(toml: string | null, flags: string[] = [], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dacc-config-'));
  dirs.push(dir);
  if (toml !== null) writeFileSync(join(dir, 'config.toml'), toml);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DITHER_ACCOUNTS_')));
  const p = Bun.spawn(['bun', MAIN, '--data', dir, ...flags], { env: { ...clean, ...env }, stdout: 'pipe', stderr: 'inherit' });
  procs.push(p);
  const reader = p.stdout.getReader();
  let out = '';
  while (!out.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return out.split('\n')[0]!;
}
const urlOf = (line: string) => line.match(/ on (\S+)/)![1]!;
const pageOf = (line: string) => line.match(/ page=(\S+)/)![1]!;

test('without a config file: loopback and a localhost page', async () => {
  const line = await start(null, ['--port', '0']);
  expect(urlOf(line)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(pageOf(line)).toBe('http://localhost:0');
  expect((await fetch(`${urlOf(line)}/api/health`)).status).toBe(200);
}, 20_000);

test("config.toml's [manager] table sets the page's URL and the port", async () => {
  const line = await start('[manager]\nport = 0\npublic_url = "https://accounts.example.net"\ntrace = 0\n');
  expect(pageOf(line)).toBe('https://accounts.example.net');
  expect((await fetch(`${urlOf(line)}/api/health`)).status).toBe(200);
}, 20_000);

test('a flag or the environment wins over the file', async () => {
  const toml = '[manager]\nport = 0\npublic_url = "https://from-file.example.net"\n';
  expect(pageOf(await start(toml, ['--public-url', 'https://from-flag.example.net']))).toBe('https://from-flag.example.net');
  expect(pageOf(await start(toml, [], { DITHER_ACCOUNTS_PUBLIC_URL: 'https://from-env.example.net' }))).toBe('https://from-env.example.net');
}, 30_000);

test('launch: auto is a child outside systemd; the flag or the file picks another (docs/supervisor.md)', async () => {
  const launchOf = (line: string) => line.match(/ launch=(\S+)/)![1]!;
  expect(launchOf(await start(null, ['--port', '0'], { INVOCATION_ID: '' }))).toBe('child');
  expect(launchOf(await start(null, ['--port', '0', '--launch', 'detached']))).toBe('detached');
  expect(launchOf(await start('[manager]\nport = 0\nlaunch = "child"\n'))).toBe('child');
}, 30_000);
