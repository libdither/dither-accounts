/** pickFreeXDisplay (pickFreeDisplay on the x11 backend): a display that is taken, claimed, or that the caller skips, is passed over; a full range throws. */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_MS, claimDisplay, displayIsOurs, displayTaken, pickFreeXDisplay } from '../src/display.ts';

// Claims go to a directory of this file's own, not the machine's, so a test never holds a display a live sandbox wants.
process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-file-'));

test('a display comes without a port (its live view is a socket), and a skipped one is passed over', async () => {
  const first = await pickFreeXDisplay();
  expect(first).toEqual({ backend: 'x11', display: first.display });
  expect(displayTaken(first.display)).toBe(false);
  const next = await pickFreeXDisplay();
  expect(next.display).toBeGreaterThan(first.display);
  expect((await pickFreeXDisplay(undefined, [next.display + 1])).display).not.toBe(next.display + 1);
});

test('no free display in the range: it says so', async () => {
  const { display } = await pickFreeXDisplay();
  await expect(pickFreeXDisplay({ from: display, to: display }, [display])).rejects.toThrow(`no free X display in :${display}–:${display}`);
});

test('past :80–:89 the default goes on at :100, never into Discord\'s :90–:99', async () => {
  const skip = Array.from({ length: 10 }, (_, i) => 80 + i);
  const next = await pickFreeXDisplay(undefined, skip);
  expect(next.display).toBeGreaterThanOrEqual(100);
  expect(next.display).toBeLessThanOrEqual(159);
});

describe("an X server's leftovers: a dead server's display is free again", () => {
  const root = mkdtempSync(join(tmpdir(), 'display-root-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const lock = (n: number, body: string) => writeFileSync(join(root, `.X${n}-lock`), body);
  const deadPid = () => {
    const p = Bun.spawnSync(['true']);
    return p.pid;
  };

  test("a lock naming a live process is taken; one whose process is gone is free, its socket with it", () => {
    mkdirSync(join(root, '.X11-unix'), { recursive: true });
    lock(1, `${String(process.pid).padStart(10)}\n`);
    expect(displayTaken(1, root)).toBe(true);
    lock(2, `${String(deadPid()).padStart(10)}\n`);
    writeFileSync(join(root, '.X11-unix', 'X2'), '');
    expect(displayTaken(2, root)).toBe(false);
  });
  test('a lock without a pid, or a socket without a lock, still counts as taken; nothing at all is free', () => {
    lock(3, 'garbled');
    expect(displayTaken(3, root)).toBe(true);
    lock(4, '');
    expect(displayTaken(4, root)).toBe(true);
    writeFileSync(join(root, '.X11-unix', 'X5'), '');
    expect(displayTaken(5, root)).toBe(true);
    expect(displayTaken(6, root)).toBe(false);
  });
  test("up and ours only once the lock names our server: a dead server's socket left behind is not enough", () => {
    const ours = process.pid;
    writeFileSync(join(root, '.X11-unix', 'X7'), '');
    lock(7, `${String(deadPid()).padStart(10)}\n`);
    expect(displayIsOurs(7, ours, root)).toBe(false);
    lock(7, `${String(ours).padStart(10)}\n`);
    expect(displayIsOurs(7, ours, root)).toBe(true);
    lock(7, `${String(process.ppid).padStart(10)}\n`);
    expect(displayIsOurs(7, ours, root)).toBe(false);
    expect(displayIsOurs(7, process.ppid, root)).toBe(true);
    expect(displayIsOurs(8, ours, root)).toBe(false);
  });
});

describe('claims: extractors starting together never pick the same display', () => {
  const dir = mkdtempSync(join(tmpdir(), 'display-claims-'));
  beforeEach(() => {
    process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(dir, 'c-'));
  });
  afterAll(() => {
    delete process.env.DITHER_DISPLAY_CLAIMS;
    rmSync(dir, { recursive: true, force: true });
  });

  test('picks made at the same moment get different displays', async () => {
    const got = await Promise.all([pickFreeXDisplay(), pickFreeXDisplay(), pickFreeXDisplay()]);
    expect(new Set(got.map((g) => g.display)).size).toBe(3);
  });

  test("a live claim under 20 s holds; a dead process's claim, or an old one, is taken over", () => {
    const now = Date.now();
    expect(claimDisplay(150, now, process.ppid)).toBe(true);
    expect(claimDisplay(150, now + 1000)).toBe(false);
    expect(claimDisplay(150, now + CLAIM_MS + 1)).toBe(true);
    writeFileSync(join(process.env.DITHER_DISPLAY_CLAIMS!, '151'), `999999999 ${now}\n`);
    expect(claimDisplay(151, now + 1)).toBe(true);
    expect(readFileSync(join(process.env.DITHER_DISPLAY_CLAIMS!, '151'), 'utf8')).toBe(`${process.pid} ${now + 1}\n`);
  });
});
