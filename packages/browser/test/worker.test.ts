/**
 * The extension's service worker (src/worker.ts): Chromium keeps running the one it first registered in a profile, so
 * the sandbox clears the profile's service workers, and nothing else, when the copied worker changed. The unit part
 * runs on stand-in profiles. The browser part runs a probe extension in a real Chromium three times on one profile and
 * is skipped without Xvfb, chromium or x11vnc. Every process it starts is gone at the end.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickFreeDisplay } from '../src/display.ts';
import { resolveBins, Sandbox } from '../src/sandbox.ts';
import { importedScripts, refreshWorker, WORKER_HASH, WORKER_STORAGE, workerHash } from '../src/worker.ts';

process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-worker-'));
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-worker-${p}-`));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function extension(dir: string, sw: string | null) {
  mkdirSync(dir, { recursive: true });
  const manifest: any = { manifest_version: 3, name: 'worker probe', version: '1.0.0', host_permissions: ['http://127.0.0.1/*'] };
  if (sw !== null) {
    manifest.background = { service_worker: 'sw.js' };
    writeFileSync(join(dir, 'sw.js'), sw);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
/** A profile as Chromium leaves one: the worker storage, and what holds the sign-in. */
function profile(dir: string) {
  const files = ['Default/Cookies', 'Default/Local Storage/leveldb/000003.log', 'Default/IndexedDB/https_example.com_0.indexeddb.leveldb/CURRENT', 'Default/Preferences', `${WORKER_STORAGE}/Database/CURRENT`, `${WORKER_STORAGE}/ScriptCache/index`];
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), f);
  }
}
const KEPT = ['Default/Cookies', 'Default/Local Storage/leveldb/000003.log', 'Default/IndexedDB/https_example.com_0.indexeddb.leveldb/CURRENT', 'Default/Preferences'];

test("the worker's hash: its manifest entry and its script; none without one", () => {
  const a = workerHash(extension(join(tmp('hash'), 'a'), 'one();'));
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(workerHash(extension(join(tmp('hash'), 'b'), 'one();'))).toBe(a);
  expect(workerHash(extension(join(tmp('hash'), 'c'), 'two();'))).not.toBe(a);
  const d = extension(join(tmp('hash'), 'd'), 'one();');
  const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...m, background: { service_worker: 'sw.js', type: 'module' } }));
  expect(workerHash(d)).not.toBe(a);
  expect(workerHash(extension(join(tmp('hash'), 'e'), null))).toBeNull();
  expect(workerHash(tmp('empty'))).toBeNull();
});

test("what the worker imports is hashed with it (the finance kinds' page.js): a changed page.js is a new worker", () => {
  expect(importedScripts("try { importScripts('page.js'); } catch (e) {}\nimportScripts('a.js', \"b.js\");")).toEqual(['page.js', 'a.js', 'b.js']);
  const make = (name: string, page: string) => {
    const d = extension(join(tmp('imports'), name), "importScripts('page.js');");
    writeFileSync(join(d, 'page.js'), page);
    return workerHash(d);
  };
  const a = make('a', 'self.PAGE = { one() {} };');
  expect(make('b', 'self.PAGE = { one() {} };')).toBe(a);
  expect(make('c', 'self.PAGE = { two() {} };')).not.toBe(a);
});

test('a new worker clears the profile service workers and nothing else; the same one leaves them; a held profile is not touched', () => {
  const acc = tmp('acc');
  const prof = join(acc, 'profile');
  const ext = extension(join(acc, 'extension'), 'one();');
  profile(prof);
  // No hash kept yet (a profile from before this, or a new one): cleared once.
  expect(refreshWorker(acc, prof, ext)).toBe('cleared');
  expect(existsSync(join(prof, WORKER_STORAGE))).toBe(false);
  for (const f of KEPT) expect(readFileSync(join(prof, f), 'utf8')).toBe(f);
  expect(readFileSync(join(acc, WORKER_HASH), 'utf8').trim()).toBe(workerHash(ext)!);
  expect(statSync(join(acc, WORKER_HASH)).mode & 0o777).toBe(0o600);
  // Chromium registered it again; the next start has the same worker: left alone.
  profile(prof);
  expect(refreshWorker(acc, prof, ext)).toBe('same');
  expect(existsSync(join(prof, WORKER_STORAGE, 'ScriptCache/index'))).toBe(true);
  // A browser holds the profile (its SingletonLock names a live pid): nothing touched, and no hash kept, so the next
  // start tries again.
  writeFileSync(join(ext, 'sw.js'), 'two();');
  symlinkSync(`${hostname()}-${process.pid}`, join(prof, 'SingletonLock'));
  expect(refreshWorker(acc, prof, ext)).toBe('busy');
  expect(existsSync(join(prof, WORKER_STORAGE, 'ScriptCache/index'))).toBe(true);
  expect(readFileSync(join(acc, WORKER_HASH), 'utf8').trim()).not.toBe(workerHash(ext)!);
  // The lock of a browser that is gone (killed, so it left its lock behind) holds nothing.
  rmSync(join(prof, 'SingletonLock'));
  symlinkSync(`${hostname()}-999999999`, join(prof, 'SingletonLock'));
  expect(refreshWorker(acc, prof, ext)).toBe('cleared');
  expect(existsSync(join(prof, WORKER_STORAGE))).toBe(false);
  for (const f of KEPT) expect(readFileSync(join(prof, f), 'utf8')).toBe(f);
  // An extension without a worker: nothing to do.
  expect(refreshWorker(acc, prof, extension(join(acc, 'plain'), null))).toBe('none');
});

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`worker: the browser part skipped, ${(e as Error).message}`);
}

test.skipIf(!bins)(
  'in Chromium: a changed worker runs on the next start, an unchanged one keeps the profile as it is, the sign-in stays',
  async () => {
    const reports: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/report') {
          reports.push(u.searchParams.toString());
          return new Response('ok');
        }
        // The page: says what it remembers (a lasting cookie, a Local Storage item), then remembers them.
        return new Response(
          `<html><body>probe<script>
            fetch('/report?who=page&cookie=' + (/probe=1/.test(document.cookie) ? 'yes' : 'no') + '&ls=' + (localStorage.getItem('probe') || 'no'));
            document.cookie = 'probe=1; max-age=86400; path=/';
            localStorage.setItem('probe', 'yes');
          </script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const acc = tmp('chromium');
    const src = join(acc, 'src');
    const worker = (tag: string) => `fetch(chrome.runtime.getURL('config.json')).then((r) => r.json()).then((c) => fetch(c.origin + '/report?who=worker&tag=${tag}'));`;
    const logs: string[] = [];
    async function start(tag: string, hold = 2000) {
      extension(src, worker(tag));
      reports.length = 0;
      logs.length = 0;
      const free = await pickFreeDisplay();
      const sb = new Sandbox({ accountDir: acc, display: free.display, width: 800, height: 600, extensionSrc: src, config: { origin }, startUrl: `${origin}/`, log: (_l, m) => logs.push(m) });
      try {
        await sb.start();
        const end = Date.now() + 30_000;
        while (Date.now() < end && !(reports.some((r) => r.startsWith('who=worker')) && reports.some((r) => r.startsWith('who=page')))) await Bun.sleep(200);
        // Long enough for a second worker to say so, were there one.
        await Bun.sleep(hold);
      } finally {
        await sb.stop();
      }
      return {
        workers: [...new Set(reports.filter((r) => r.startsWith('who=worker')).map((r) => new URLSearchParams(r).get('tag')))],
        page: reports.find((r) => r.startsWith('who=page')) ?? null,
        cleared: logs.some((m) => m.includes('cleared its service workers')),
      };
    }
    try {
      // Held past Chromium's cookie commit (every 30 s), so the cookie is on disk as a sign-in's would be.
      expect(await start('first', 33_000)).toEqual({ workers: ['first'], page: 'who=page&cookie=no&ls=no', cleared: true });
      // The same worker: the profile's service workers stay (Chromium runs the one it has, which is this one).
      expect(await start('first')).toEqual({ workers: ['first'], page: 'who=page&cookie=yes&ls=yes', cleared: false });
      // A changed worker: without the clear Chromium would run 'first' again.
      expect(await start('second')).toEqual({ workers: ['second'], page: 'who=page&cookie=yes&ls=yes', cleared: true });
      expect(await start('second')).toEqual({ workers: ['second'], page: 'who=page&cookie=yes&ls=yes', cleared: false });
    } finally {
      server.stop(true);
    }
  },
  180_000,
);
