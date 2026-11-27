/**
 * Stopping a browser sandbox (src/sandbox.ts) whatever its screen does: a screen whose stop throws and whose files
 * cannot be removed still has every process ended (Chromium, the compositor, the live view's server, the bus), the
 * failures said in the log; and a second stop waits for the first. On a real headless sway with a stand-in Chromium
 * (a process that only waits), so only sway, wayvnc and grim are needed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { wayland, why } from '../../../test/needs.ts';
import { BINS } from '../../sandbox/src/bins.ts';
import { resolveBin } from '../src/bins.ts';
import { Sandbox } from '../src/sandbox.ts';
import { waylandDir } from '../src/wayland.ts';

process.env.DITHER_DISPLAY_CLAIMS ??= mkdtempSync(join(tmpdir(), 'display-claims-stop-'));
const root = mkdtempSync(join(tmpdir(), 'dacc-sbstop-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!why('sway, wayvnc and grim', wayland))('stopping a sandbox', () => {
  test("a screen whose stop throws and whose directory cannot be removed: every process still ends, and it is said", async () => {
    const acc = join(root, 'acct');
    const src = join(root, 'ext');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0' }));
    // A stand-in for Chromium: it runs until it is ended.
    const sleep = join(dirname(resolveBin(BINS.env, () => {})), 'sleep');
    const chromium = join(root, 'chromium');
    writeFileSync(chromium, `#!${resolveBin(BINS.sh, () => {})}\nexec ${sleep} 600\n`, { mode: 0o755 });
    const logs: string[] = [];
    const sb = new Sandbox({ accountDir: acc, display: { backend: 'wayland', display: null }, width: 640, height: 480, extensionSrc: src, config: {}, startUrl: 'about:blank', chromium, log: (l, m) => logs.push(`${l} ${m}`) });
    await sb.start();
    const started = (sb as unknown as { procs: { name: string; proc: Subprocess }[] }).procs.slice();
    expect(started.map((p) => p.name)).toEqual(expect.arrayContaining(['sway', 'wayvnc', 'chromium']));
    const wl = waylandDir(acc);
    // Its stop fails outright, and its directory cannot be emptied (sway, PipeWire or WirePlumber still writing there
    // made it ENOTEMPTY before; here, no write access).
    sb.screen!.stop = () => Promise.reject(new Error('forced: the screen would not stop'));
    chmodSync(wl, 0o500);
    try {
      const first = sb.stop();
      const second = sb.stop();
      expect(second).toBe(first);
      await first;
      for (const p of started) expect([p.name, p.proc.exitCode !== null || p.proc.signalCode !== null]).toEqual([p.name, true]);
      expect(logs).toContain('warn stopping the screen: forced: the screen would not stop');
      expect(logs.some((l) => /^warn removing the screen's files: .*EACCES/.test(l))).toBe(true);
      expect(logs.at(-1)).toBe('info sandbox stopped');
      expect(existsSync(sb.vncSocket)).toBe(false);
    } finally {
      chmodSync(wl, 0o700);
    }
  }, 60_000);
});
