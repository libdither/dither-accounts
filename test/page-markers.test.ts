/**
 * The names our extensions leave in pages (packages/browser/src/markers.ts): made per install and account, from the
 * manager's own secret, when the extension is copied. Two installs show a site different names; every extension's copy
 * holds no placeholder and nothing that names us; both ends of each channel agree. The browser suites (x-browser and
 * the others) show the copied extensions still work in a real Chromium.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox as DiscordSandbox } from '../extractors/discord/src/sandbox.ts';
import { prepareDriver } from '../extractors/statements-common/src/tabs.ts';
import { expandIncludes, MARKER_KEY_ENV, markerHex, markerKey, markerName, stampMarkers } from '../packages/browser/src/markers.ts';
import { Sandbox } from '../packages/browser/src/sandbox.ts';
import { Store } from '../packages/manager/src/db.ts';
import { pageMarkerKey } from '../packages/manager/src/supervisor.ts';

const ROOT = join(import.meta.dir, '..');
const IDENT = /^[A-Za-z][A-Za-z0-9]{7,14}$/;
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `dacc-markers-${p}-`));
  dirs.push(d);
  return d;
};
const stores: Store[] = [];
afterAll(() => {
  for (const s of stores) s.db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function install(dir = tmp('install')): Store {
  const s = new Store(join(dir, 'accounts.sqlite'));
  stores.push(s);
  return s;
}

/** Every extension a kind copies, as its sandbox copies it: the shared Sandbox's copy step, or Discord's own. */
const KINDS = ['discord', 'google', 'meta', 'privacy', 'proton', 'x', 'amazon', 'venmo', 'schwab'].filter((k) => existsSync(join(ROOT, 'extractors', k, 'src/extension')));
function copyOf(kind: string, key: string): string {
  const accountDir = tmp(kind);
  const log = () => {};
  const base = { accountDir, display: 99, width: 800, height: 600, startUrl: 'about:blank', log };
  if (kind === 'discord') {
    const sb = new DiscordSandbox({ ...base, wsUrl: 'ws://127.0.0.1:1/', token: 't', markerKey: key });
    sb['prepareExtension']();
    return sb.extensionDir;
  }
  const sb = new Sandbox({
    ...base,
    extensionSrc: join(ROOT, 'extractors', kind, 'src/extension'),
    config: { wsUrl: 'ws://127.0.0.1:1/', token: 't' },
    // venmo, amazon and schwab: statements-common's driver comes in as sw.js (statements-common/src/tabs.ts), with
    // the passkey's part for schwab.
    prepareExtension: ['amazon', 'venmo', 'schwab'].includes(kind) ? (d) => prepareDriver(d, { passkeys: kind === 'schwab' }) : undefined,
    markerKey: key,
  });
  sb['prepareExtension']();
  return sb.extensionDir;
}
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(dir, f)).isFile());
}
/** The channel's event type a copy's hook.js or content.js says `up` with (packages/browser/src/page). */
const tagOf = (src: string) => src.match(/const UP = '([^']*)'/)?.[1];
const downOf = (src: string) => src.match(/const DOWN = '([^']*)'/)?.[1];

test('the install secret is made once and kept; two installs, and two accounts of one, get different keys', () => {
  const dir = tmp('kept');
  const a = install(dir);
  const k1 = pageMarkerKey(a, 'acc_one');
  expect(pageMarkerKey(a, 'acc_one')).toBe(k1);
  expect(pageMarkerKey(install(dir), 'acc_one')).toBe(k1); // the registry reopened: the same names as before
  expect(pageMarkerKey(a, 'acc_two')).not.toBe(k1);
  const b = install();
  expect(b.installValue('page-markers')).not.toBe(a.installValue('page-markers'));
  expect(pageMarkerKey(b, 'acc_one')).not.toBe(k1);
});

test('names: identifier-like, never ours, the same for one key and label, different across keys and labels', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const n = markerName(`key-${i}`, 'channel');
    expect(n).toMatch(IDENT);
    expect(n).not.toMatch(/dither/i);
    seen.add(n);
  }
  expect(seen.size).toBe(2000);
  expect(markerName('k'.repeat(20), 'channel')).toBe(markerName('k'.repeat(20), 'channel'));
  expect(markerName('k'.repeat(20), 'channel')).not.toBe(markerName('k'.repeat(20), 'installed'));
  expect(markerHex('k'.repeat(20), 'audioGroup')).toMatch(/^[0-9a-f]{64}$/);
  expect(stampMarkers(`a '__MARK_channel__' b "__MARKHEX_audioGroup__" c __MARK_channel__`, 'k'.repeat(20))).toBe(
    `a '${markerName('k'.repeat(20), 'channel')}' b "${markerHex('k'.repeat(20), 'audioGroup')}" c ${markerName('k'.repeat(20), 'channel')}`,
  );
  // An extractor the manager did not start makes its own key, once per process: never a name every install shares.
  expect(markerKey({ [MARKER_KEY_ENV]: 'given-by-the-manager-0123' })).toBe('given-by-the-manager-0123');
  expect(markerKey({})).toBe(markerKey({}));
  expect(markerKey({}).length).toBeGreaterThanOrEqual(32);
});

test('every extension copy: no placeholder left, nothing that names us, both ends of the channel on one name', () => {
  expect(KINDS.length).toBeGreaterThanOrEqual(6);
  const key = pageMarkerKey(install(), 'acc_test');
  for (const kind of KINDS) {
    const ext = copyOf(kind, key);
    for (const f of files(ext)) {
      const text = readFileSync(join(ext, f), 'utf8');
      expect({ kind, f, left: text.match(/__MARK\w*|dither/i)?.[0] ?? null }).toEqual({ kind, f, left: null });
      if (f.endsWith('.js')) new Function(text); // still parses
      if (f.endsWith('.json')) JSON.parse(text);
    }
    // Placeholders only where Chromium reads the copy at every start: a service worker is kept from the first start.
    const worker = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).background?.service_worker;
    if (worker) {
      const common = join(ROOT, 'extractors/statements-common/extension');
      const src =
        kind === 'amazon' || kind === 'venmo' || kind === 'schwab'
          ? readFileSync(join(common, 'driver.js'), 'utf8') + (kind === 'schwab' ? readFileSync(join(common, 'passkeys.js'), 'utf8') : '')
          : readFileSync(join(ROOT, 'extractors', kind, 'src/extension', worker), 'utf8');
      // What the copy puts into the worker (webauthn-worker.js) counts too.
      expect({ kind, worker, placeholder: /__MARK/.test(expandIncludes(src)) }).toEqual({ kind, worker, placeholder: false });
    }
    if (!existsSync(join(ext, 'hook.js'))) continue;
    const hook = readFileSync(join(ext, 'hook.js'), 'utf8');
    const content = readFileSync(join(ext, 'content.js'), 'utf8');
    expect(tagOf(hook)).toBe(markerName(key, 'up'));
    expect(tagOf(content)).toBe(tagOf(hook));
    expect(downOf(hook)).toBe(markerName(key, 'down'));
    expect(downOf(content)).toBe(downOf(hook));
    // Both ends are the shared ones, put in by the copy: no window messages, no marks on window.
    expect(hook).not.toMatch(/postMessage|Symbol\.for\('(?!react\.)/);
    expect(content).not.toMatch(/window\.postMessage|addEventListener\('message'/);
    for (const [, k] of hook.matchAll(/Symbol\.for\('([^']*)'\)/g)) if (!k.startsWith('react.')) expect(k).toMatch(IDENT);
  }
});

test('two installs: the same extension shows a page different names', () => {
  const [a, b] = [install(), install()].map((s) => pageMarkerKey(s, 'acc_same'));
  for (const kind of ['discord', 'meta', 'privacy', 'proton', 'x', 'google']) {
    const [ha, hb] = [a, b].map((k) => readFileSync(join(copyOf(kind, k), 'hook.js'), 'utf8'));
    const [ta, tb] = [tagOf(ha)!, tagOf(hb)!];
    expect(ta).toMatch(IDENT);
    expect(tb).toMatch(IDENT);
    expect(ta).not.toBe(tb);
    expect(hb).not.toContain(ta);
    expect(ha).not.toContain(tb);
  }
  // The rest of what Discord's hook leaves: a sessionStorage key, a probe key, a microphone's groupId.
  const [da, db] = [a, b].map((k) => readFileSync(join(copyOf('discord', k), 'hook.js'), 'utf8'));
  for (const label of ['reloads', 'noSuchKey']) {
    expect(da).toContain(`'${markerName(a, label)}'`);
    expect(db).toContain(`'${markerName(b, label)}'`);
  }
  expect(da).toContain(`groupId: '${markerHex(a, 'audioGroup')}'`);
  expect(db).not.toContain(markerHex(a, 'audioGroup'));
});
