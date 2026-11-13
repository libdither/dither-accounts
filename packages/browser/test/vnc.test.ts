/**
 * The live view's socket (src/vnc.ts): where it goes, its directory's and its own modes, and a real x11vnc on it that
 * answers RFB there and holds no inet socket at all (no TCP port, v4 or v6). The x11vnc part is skipped without Xvfb
 * or x11vnc; every process it starts is gone at the end.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { pickFreeDisplay } from '../src/display.ts';
import { resolveBins } from '../src/sandbox.ts';
import { prepareVncSocket, SOCKET_PATH_MAX, vncSocketPath, waitForVncSocket, x11vncArgs } from '../src/vnc.ts';
import { inetSockets, rfbBanner } from './inet.ts';

process.env.DITHER_DISPLAY_CLAIMS = mkdtempSync(join(tmpdir(), 'display-claims-vnc-'));
const dir = mkdtempSync(join(tmpdir(), 'dacc-vnc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the socket is vnc.sock in the account's directory, or in the runtime directory when that path is too long", () => {
  expect(vncSocketPath('/home/u/.local/share/dither-accounts/accounts/acc_x')).toBe('/home/u/.local/share/dither-accounts/accounts/acc_x/vnc.sock');
  const deep = `/home/u/${'d'.repeat(120)}/acc_x`;
  const p = vncSocketPath(deep);
  expect(Buffer.byteLength(p)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
  expect(p).toMatch(/\/dither-vnc(-\w+)?\/[0-9a-f]{16}\.sock$/);
  expect(vncSocketPath(deep)).toBe(p);
  expect(vncSocketPath(`${deep}2`)).not.toBe(p);
});

test('x11vnc gets the socket and no port: not -rfbport 0 alone (that leaves [::]:5900), and no -localhost', () => {
  const a = x11vncArgs('/bin/x11vnc', ':80', '/a/vnc.sock');
  const flag = (f: string) => a[a.indexOf(f) + 1];
  expect(flag('-unixsock')).toBe('/a/vnc.sock');
  expect(flag('-rfbport')).toBe('0');
  expect(flag('-rfbportv6')).toBe('-1');
  expect(a).toContain('-no6');
  expect(a).not.toContain('-localhost');
});

test("its directory is made 0700, or closed if it was open; a stale socket goes; a path too long is refused", () => {
  const fresh = join(dir, 'fresh', 'vnc.sock');
  prepareVncSocket(fresh);
  expect(statSync(dirname(fresh)).mode & 0o777).toBe(0o700);
  const open = join(dir, 'open');
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  writeFileSync(join(open, 'vnc.sock'), 'stale');
  prepareVncSocket(join(open, 'vnc.sock'));
  expect(statSync(open).mode & 0o777).toBe(0o700);
  expect(existsSync(join(open, 'vnc.sock'))).toBe(false);
  expect(() => prepareVncSocket(`/tmp/${'x'.repeat(120)}/vnc.sock`)).toThrow('too long');
});

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  const b = resolveBins(() => {});
  bins = b.xvfb && b.x11vnc ? b : null;
} catch {
  bins = null;
}

describe.skipIf(!bins)('a real x11vnc', () => {
  const procs: Subprocess[] = [];
  afterAll(async () => {
    for (const p of procs) p.kill('SIGKILL');
    await Promise.all(procs.map((p) => p.exited));
  });

  test('answers RFB on the socket (0600), and holds no TCP or UDP socket, v4 or v6', async () => {
    const { display } = await pickFreeDisplay();
    const xvfb = Bun.spawn([bins!.xvfb, `:${display}`, '-screen', '0', '640x480x24', '-nolisten', 'tcp'], { stdout: 'ignore', stderr: 'ignore' });
    procs.push(xvfb);
    for (let i = 0; i < 80 && !existsSync(`/tmp/.X11-unix/X${display}`); i++) await Bun.sleep(100);
    const sock = vncSocketPath(join(dir, 'acc'));
    prepareVncSocket(sock);
    const vnc = Bun.spawn(x11vncArgs(bins!.x11vnc, `:${display}`, sock), { stdout: 'ignore', stderr: 'ignore' });
    procs.push(vnc);
    await waitForVncSocket(sock, vnc, 10_000);
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(sock)).mode & 0o777).toBe(0o700);
    expect(await rfbBanner(sock)).toMatch(/^RFB \d{3}\.\d{3}\n$/);
    // x11vnc sets up its listeners at start; give a late one (the IPv6 port that -rfbport 0 alone leaves) time to show.
    await Bun.sleep(1500);
    expect(vnc.exitCode).toBeNull();
    expect(inetSockets(vnc.pid)).toEqual([]);
  }, 30_000);
});
