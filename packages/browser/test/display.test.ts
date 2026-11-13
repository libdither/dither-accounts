/** pickFreeDisplay: a display that is taken, claimed, or that the caller skips, is passed over; a full range throws. */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_MS, claimDisplay, displayTaken, pickFreeDisplay } from '../src/display.ts';

// Claims go to a directory of this file's own, not the machine's, so a test never holds a display a live sandbox wants.
process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-file-'));

test('a display comes without a port (its live view is a socket), and a skipped one is passed over', async () => {
  const first = await pickFreeDisplay();
  expect(first).toEqual({ display: first.display });
  expect(displayTaken(first.display)).toBe(false);
  const next = await pickFreeDisplay();
  expect(next.display).toBeGreaterThan(first.display);
  expect((await pickFreeDisplay(undefined, [next.display + 1])).display).not.toBe(next.display + 1);
});

test('no free display in the range: it says so', async () => {
  const { display } = await pickFreeDisplay();
  await expect(pickFreeDisplay({ from: display, to: display }, [display])).rejects.toThrow(`no free X display in :${display}–:${display}`);
});

test('past :80–:89 the default goes on at :100, never into Discord\'s :90–:99', async () => {
  const skip = Array.from({ length: 10 }, (_, i) => 80 + i);
  const next = await pickFreeDisplay(undefined, skip);
  expect(next.display).toBeGreaterThanOrEqual(100);
  expect(next.display).toBeLessThanOrEqual(159);
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
    const got = await Promise.all([pickFreeDisplay(), pickFreeDisplay(), pickFreeDisplay()]);
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
