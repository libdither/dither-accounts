/**
 * Chromium keeps an extension's service worker in the profile and goes on running the script it first registered,
 * whatever the extension's copy on disk or its manifest's version says. That holds for Chromium 155, an unpacked
 * extension loaded from the command line, and a persistent profile. A probe showed it: content scripts always ran the
 * current copy, but the worker ran the first start's script through two version bumps, after its registration was
 * cleared from Preferences, and after its file was renamed (then no worker ran at all). Only removing the profile's
 * `Default/Service Worker` made the current one run.
 *
 * The scripts a worker loads with importScripts('…') (the finance kinds' page.js) are kept with it the same way, so
 * they are hashed with it.
 *
 * So before each launch, the sandbox hashes the worker as copied (the manifest's `background` and the script) and keeps
 * that hash in the account's directory. When the hash differs from the last launch's, or none is kept, it removes
 * `<profile>/Default/Service Worker`, and the current worker registers and runs. Nothing else is removed: cookies,
 * Local Storage, IndexedDB and so the sign-in stay. The sites' own service workers go with that directory, and they
 * register again on their next visit.
 *
 * Never while a browser runs on the profile: Chromium's `SingletonLock` names its pid. With a live pid there, the
 * worker storage is left alone and no hash is kept, so the next launch tries again.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The hash of the worker that last launched, in the account's directory. */
export const WORKER_HASH = 'extension-worker.sha256';
/** What Chromium keeps service workers in, extensions' and sites' alike. */
export const WORKER_STORAGE = join('Default', 'Service Worker');

/** The files a worker script imports by name: importScripts('a.js', "b.js"). */
export function importedScripts(src: string): string[] {
  const out: string[] = [];
  for (const call of src.matchAll(/importScripts\s*\(([^)]*)\)/g)) for (const m of call[1]!.matchAll(/['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

/** The extension's worker as copied: its manifest's `background`, the script and what it imports, hashed. Null when it has none. */
export function workerHash(extensionDir: string): string | null {
  let background: { service_worker?: string } | undefined;
  try {
    background = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')).background;
  } catch {
    return null;
  }
  if (!background?.service_worker) return null;
  const h = createHash('sha256').update(JSON.stringify(background)).update('\0');
  let src: Buffer | null = null;
  try {
    src = readFileSync(join(extensionDir, background.service_worker));
    h.update(src);
  } catch {
    h.update('(missing)');
  }
  for (const name of src ? importedScripts(src.toString('utf8')) : []) {
    h.update(`\0${name}\0`);
    try {
      h.update(readFileSync(join(extensionDir, name)));
    } catch {
      h.update('(missing)');
    }
  }
  return h.digest('hex');
}

/** The pid a running Chromium holds the profile with (its SingletonLock, `<host>-<pid>`), if it is alive. */
export function profileHolder(profileDir: string): number | null {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, 'SingletonLock'));
  } catch {
    return null;
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e: any) {
    return e?.code === 'EPERM' ? pid : null;
  }
}

export type WorkerRefresh = 'same' | 'cleared' | 'busy' | 'none';

/**
 * Before a launch: if the copied worker is not the one the profile last ran, remove the profile's service worker
 * storage so Chromium registers the current one. Answers what it did: `same` (the worker did not change), `cleared`,
 * `busy` (a browser holds the profile: nothing touched), `none` (the extension has no worker).
 */
export function refreshWorker(accountDir: string, profileDir: string, extensionDir: string): WorkerRefresh {
  const hash = workerHash(extensionDir);
  if (!hash) return 'none';
  const kept = join(accountDir, WORKER_HASH);
  let last: string | null = null;
  try {
    last = readFileSync(kept, 'utf8').trim();
  } catch {}
  if (last === hash) return 'same';
  if (profileHolder(profileDir) !== null) return 'busy';
  const storage = join(profileDir, WORKER_STORAGE);
  if (existsSync(storage)) rmSync(storage, { recursive: true, force: true });
  writeFileSync(kept, `${hash}\n`, { mode: 0o600 });
  return 'cleared';
}
