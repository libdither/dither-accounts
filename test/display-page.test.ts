/**
 * The manager's page picks a display backend (packages/manager/web/src/ui/Display.tsx), in a headless Chromium against
 * a fresh manager on a page built for the test: the default's picker on the home page and an account's own in its
 * pane, each confirmed (it moves), cancelled (the picker goes back to what is in force, and nothing is sent), and
 * offered one that cannot run here now (disabled, saying why; forced, it is put back and nothing is sent) and one whose
 * fork's servers were never built ("built when picked": confirming starts the build, and the pick is refused
 * meanwhile, so nothing moves). Whether each backend can run here is the test's to say (backendCheck), not this
 * machine's.
 *
 * Needs Chromium prepared from the pinned nixpkgs (DITHER_BINS) or CHROMIUM_BIN; skipped without it, except in CI's nix job
 * (DITHER_TESTS_NEED_ALL). DITHER_PAGE_SHOTS=<dir> also saves pictures of each view (the pull request's screenshots).
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import type { DisplayBackend } from '@dither-accounts/spec/display';
import fakeManifest from '../extractors/fake/manifest.ts';
import { preparedBin } from '../packages/browser/src/bins.ts';
import { CHROMIUM } from '../packages/browser/src/sandbox.ts';
import { newToken } from '../packages/manager/src/db.ts';
import type { BackendCheck } from '../packages/manager/src/http.ts';
import { launch, type Page } from '../scripts/browser.ts';
import { why } from './needs.ts';

setDefaultTimeout(90_000);

const ROOT = resolve(import.meta.dir, '..');
// The pinned one only (prepared, or CHROMIUM_BIN): a runner's own may be a wrapper that cannot start headless here.
const chromium = process.env.CHROMIUM_BIN || preparedBin(CHROMIUM);
const it = test.skipIf(!why('Chromium from the pinned nixpkgs (bun scripts/prepare-bins.ts, then DITHER_BINS)', !!chromium));
const SHOTS = process.env.DITHER_PAGE_SHOTS;

const checks: Partial<Record<DisplayBackend, BackendCheck>> = {};
let dir = '';
let m: Manager | null = null;
let browser: Awaited<ReturnType<typeof launch>> | null = null;
let p: Page;
const ID = 'acc-page-ann';
/** What the page sent: each PUT /api/display and PATCH of the account, in order. */
const sent: string[] = [];

beforeAll(async () => {
  if (!chromium) return;
  dir = mkdtempSync(join(tmpdir(), 'dacc-display-page-'));
  const dist = join(dir, 'dist');
  const built = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: join(ROOT, 'packages/manager/web'), stdout: 'ignore', stderr: 'pipe' });
  if (built.exitCode !== 0) throw new Error(`the page did not build: ${built.stderr.toString().slice(-400)}`);
  // An invented account, signed in as an invented person.
  const fake = kindOf(fakeManifest, join(ROOT, 'extractors/fake'));
  m = await createManager({ openPage: true, dataDir: join(dir, 'data'), port: 0, webDist: dist, kinds: new Map([['fake', fake]]), launch: 'child', restartPauseMs: 50, backendCheck: (b) => checks[b] ?? { availability: 'ready', why: null } });
  const accDir = join(dir, 'data', 'accounts', ID);
  mkdirSync(accDir, { recursive: true, mode: 0o700 });
  m.store.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)', ID, 'fake', 'Fake', JSON.stringify({ self: { displayName: 'Ann Lee', handle: 'ann-lee' } }), newToken(), accDir, Date.now(), Date.now());
  m.sup.start(ID);
  await until(() => m!.sup.state(ID).online, 15_000, 'the account online');
  browser = await launch({ bin: chromium! });
  p = browser.page;
  await p.size(1100, 900);
  // What the page sends, seen from its side (the answers too).
  p.on('Network.requestWillBeSent', (e) => {
    const r = e.request;
    if ((r.method === 'PUT' && r.url.endsWith('/api/display')) || (r.method === 'PATCH' && r.url.includes(`/api/accounts/${ID}`))) sent.push(`${r.method} ${r.postData}`);
  });
});
afterAll(async () => {
  await browser?.close();
  await m?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function until(f: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
const q = JSON.stringify;
const click = (sel: string) => p.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('no ' + ${q(sel)}); e.click(); })()`);
/** A pick as a person makes it: the select's value, then its change event (a disabled option too, as a script could). */
const pick = (sel: string, value: string) => p.eval(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const value = (sel: string) => p.eval<string>(`document.querySelector(${q(sel)}).value`);
const options = (sel: string) =>
  p.eval<{ value: string; text: string; disabled: boolean; availability: string | undefined }[]>(
    `[...document.querySelectorAll(${q(`${sel} option`)})].map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled, availability: o.dataset.availability }))`,
  );
const dialog = () => p.eval<string | null>(`document.querySelector('[role=dialog]')?.innerText ?? null`);
const toastText = () => p.eval<string>(`document.querySelector('.toasts')?.innerText ?? ''`);
const state = async () => (await (await fetch(`${m!.url}/api/state`)).json()) as any;
const shot = async (name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.shot(join(SHOTS, `${name}.png`));
};
/** The page polls its state; this waits for the poll that brings the test's change. */
const shows = (sel: string, name: string, availability: string) => p.until(`document.querySelector(${q(`${sel} option[value="${name}"]`)})?.dataset.availability === ${q(availability)}`, 8000);

it("the default's picker: confirmed it moves, cancelled it goes back, and one that cannot run is offered disabled and never sent", async () => {
  checks['wayland-tigervnc'] = { availability: 'missing', why: 'w0vncserver not among the prepared programs' };
  checks.tigervnc = { availability: 'building', why: "the sandboxes' programs are being built" };
  await p.send('Page.navigate', { url: m!.url });
  const sel = '[data-default-backend]';
  await p.until(`!!document.querySelector(${q(`${sel} option[value="kasmvnc"]`)})`, 10_000);
  await shows(sel, 'wayland-tigervnc', 'missing');
  const opts = await options(sel);
  expect(opts.map((o) => [o.value, o.availability ?? null, o.disabled])).toEqual([
    ['', null, false],
    ['x11', 'ready', false],
    ['tigervnc', 'building', true],
    ['kasmvnc', 'ready', false],
    ['wayland', 'ready', false],
    ['wayland-tigervnc', 'missing', true],
  ]);
  expect(opts.find((o) => o.value === 'wayland-tigervnc')!.text).toMatch(/cannot run here: w0vncserver not among the prepared programs/);
  expect(opts.find((o) => o.value === 'tigervnc')!.text).toMatch(/building…/);
  await shot('screens-picker');

  // Confirmed: sent, and in force.
  await pick(sel, 'kasmvnc');
  await until(async () => /Draw sandboxes on Xvnc \(KasmVNC\)/.test((await dialog()) ?? ''), 5000, 'the confirmation');
  expect(await dialog()).toMatch(/ann-lee restarts on it/);
  await shot('screens-confirm');
  await click('[data-confirm]');
  await until(async () => (await state()).display.chosen === 'kasmvnc', 5000, 'kasmvnc chosen');
  expect(sent).toEqual(['PUT {"default":"kasmvnc"}']);
  await p.until(`document.querySelector(${q(sel)}).value === 'kasmvnc'`, 5000);

  // Cancelled: the picker shows what is in force again, and nothing is sent.
  await pick(sel, 'wayland');
  await until(async () => (await dialog()) !== null, 5000, 'the confirmation');
  await click('[data-cancel]');
  await until(async () => (await dialog()) === null, 5000, 'the dialog gone');
  expect(await value(sel)).toBe('kasmvnc');
  expect((await state()).display.chosen).toBe('kasmvnc');

  // One that cannot run, forced: put back at once, no dialog, nothing sent.
  await pick(sel, 'wayland-tigervnc');
  expect(await dialog()).toBeNull();
  expect(await value(sel)).toBe('kasmvnc');
  expect(sent).toEqual(['PUT {"default":"kasmvnc"}']);

  // Back to config.toml's, for the next test.
  await pick(sel, '');
  await until(async () => (await dialog()) !== null, 5000, 'the confirmation');
  await click('[data-confirm]');
  await until(async () => (await state()).display.chosen === null, 5000, "config.toml's again");
  sent.length = 0;
  expect(p.errors).toEqual([]);
});

it("an account's own picker: the same, and a fork never built is built on confirming, without moving anything", async () => {
  checks['wayland-tigervnc'] = { availability: 'unbuilt', why: 'built the first time it is picked: minutes, where no cache has it' };
  checks.tigervnc = { availability: 'missing', why: 'Xvnc not found here' };
  await click('[data-tab="accounts"]');
  await p.until(`!!document.querySelector('[data-account="${ID}"]')`, 5000);
  await click(`[data-account="${ID}"]`);
  const sel = `[data-pane="${ID}"] [data-account-backend]`;
  await p.until(`!!document.querySelector(${q(sel)})`, 5000);
  await shows(sel, 'wayland-tigervnc', 'unbuilt');
  await shows(sel, 'tigervnc', 'missing');
  const opts = await options(sel);
  expect(opts.find((o) => o.value === 'wayland-tigervnc')).toMatchObject({ disabled: false });
  expect(opts.find((o) => o.value === 'wayland-tigervnc')!.text).toMatch(/built when picked/);
  expect(opts.find((o) => o.value === 'tigervnc')).toMatchObject({ disabled: true });
  await p.eval(`document.querySelector(${q(`[data-pane="${ID}"] [data-screen]`)}).scrollIntoView({ block: 'center' })`);
  await shot('account-picker');

  // Confirmed: it moves.
  await pick(sel, 'wayland');
  await until(async () => /Move ann-lee to sway \(Wayland\)/.test((await dialog()) ?? ''), 5000, 'the confirmation');
  await click('[data-confirm]');
  await until(() => m!.sup.ownBackend(m!.store.account(ID)!) === 'wayland', 5000, 'its own set to wayland');
  expect(sent).toEqual(['PATCH {"settings":{"displayBackend":"wayland"}}']);
  await p.until(`document.querySelector(${q(sel)}).value === 'wayland'`, 5000);
  // Back online on it, and the page has seen so (a move asks first only of a running account).
  await until(() => m!.sup.state(ID).online && m!.sup.details(ID).displayBackend === 'wayland', 15_000, 'it running on wayland');
  await p.until(`document.querySelector(${q(`[data-pane="${ID}"] [data-screen]`)}).innerText.includes('Now: sway (Wayland)') && document.querySelector(${q(`[data-pane="${ID}"] [data-condition]`)})?.innerText === 'Online'`, 10_000);

  // Cancelled: back to its own, nothing sent.
  await pick(sel, 'x11');
  await until(async () => (await dialog()) !== null, 5000, 'the confirmation');
  await click('[data-cancel]');
  await until(async () => (await dialog()) === null, 5000, 'the dialog gone');
  expect(await value(sel)).toBe('wayland');

  // Cannot run, forced: put back, nothing sent.
  await pick(sel, 'tigervnc');
  expect(await dialog()).toBeNull();
  expect(await value(sel)).toBe('wayland');

  // Never built: confirming asks the manager, which starts the build and refuses the pick; nothing moves.
  await pick(sel, 'wayland-tigervnc');
  await until(async () => /Build sway \(Wayland, TigerVNC\)/.test((await dialog()) ?? ''), 5000, 'the build confirmation');
  await shot('account-build-confirm');
  await click('[data-confirm]');
  await until(async () => /being built now/.test(await toastText()), 5000, 'the answer');
  await p.until(`document.querySelector(${q(sel)}).value === 'wayland'`, 5000);
  expect(m!.sup.ownBackend(m!.store.account(ID)!)).toBe('wayland');
  expect(sent).toEqual(['PATCH {"settings":{"displayBackend":"wayland"}}', 'PATCH {"settings":{"displayBackend":"wayland-tigervnc"}}']);
  // The page's own 409 is the only console error (the browser logs a failed request).
  expect(p.errors.filter((e) => !/409/.test(e))).toEqual([]);
});
