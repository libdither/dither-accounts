/**
 * The native-app sandbox on the wayland backend: a headless sway of its own with wayvnc on the live view's socket,
 * and an app under bubblewrap that is shown the compositor's socket alone, as <run>/wayland-0, with every toolkit told
 * to use it. What it must not see: an X socket, the compositor's own directory (its IPC socket, its config), the live
 * view's socket. Skipped without the native-app sandbox's programs or sway, wayvnc and grim.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSandbox, displayEnv } from '../src/sandbox.ts';
import { BINS, resolveBin } from '../src/bins.ts';
import { sandbox, wayland, why } from '../../../test/needs.ts';
import { rfbBanner } from '../../browser/test/inet.ts';

test('the display environment: DISPLAY on x11; on wayland the socket at <run>/wayland-0 and each toolkit sent to it', () => {
  expect(displayEnv({ backend: 'x11', display: 81 }, '/run/user/1')).toEqual({ DISPLAY: ':81', QT_QPA_PLATFORM: 'xcb' });
  const w = displayEnv({ backend: 'wayland', display: null }, '/run/user/1');
  expect(w).toMatchObject({ WAYLAND_DISPLAY: '/run/user/1/wayland-0', XDG_SESSION_TYPE: 'wayland', QT_QPA_PLATFORM: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'wayland' });
  expect('DISPLAY' in w).toBe(false);
});

const ok = why('the native-app sandbox on wayland (bubblewrap, dbus, sway, wayvnc, grim)', sandbox && wayland);
const it = test.skipIf(!ok);

const root = mkdtempSync(join(tmpdir(), 'dacc-sbxw-'));
const dir = join(root, 'acct', 'desktop');
let sb: AppSandbox;

const APP = `
out="$HOME/report.txt"
{
  echo "wayland=$WAYLAND_DISPLAY"
  echo "socket=$([ -S "$WAYLAND_DISPLAY" ] && echo yes || echo no)"
  echo "display=\${DISPLAY:-none}"
  echo "x=$([ -e /tmp/.X11-unix ] && ls -A /tmp/.X11-unix | tr '\\n' ' ' || echo none)"
  echo "qt=$QT_QPA_PLATFORM"
  echo "session=$XDG_SESSION_TYPE"
  echo "run=$(ls -A "$XDG_RUNTIME_DIR" | tr '\\n' ' ')"
  echo "own=$([ -e ${JSON.stringify(join(dir, 'wl'))} ] && echo visible || echo hidden)"
  echo "vnc=$([ -e ${JSON.stringify(join(dir, 'vnc.sock'))} ] && echo visible || echo hidden)"
} > "$out.tmp"
mv "$out.tmp" "$out"
exec sleep 600
`;

beforeAll(async () => {
  if (!ok) return;
  const sh = resolveBin(BINS.sh, () => {});
  const appDir = join(root, 'app');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'app.sh'), APP, { mode: 0o755 });
  sb = new AppSandbox({ dir, display: { backend: 'wayland', display: null }, width: 800, height: 600, command: [sh, join(appDir, 'app.sh')], roBinds: [appDir], settleMs: 300, log: () => {}, onEvent: () => {} });
  await sb.start();
}, 120_000);

afterAll(async () => {
  if (!ok) return;
  await sb?.stop();
  rmSync(root, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(100);
  return ok();
};

it('the live view speaks RFB on the same socket as on x11 (0600), and the screen has no display number', async () => {
  expect(sb.vncSocket).toBe(join(dir, 'vnc.sock'));
  expect(lstatSync(sb.vncSocket).mode & 0o777).toBe(0o600);
  expect(await rfbBanner(sb.vncSocket)).toMatch(/^RFB 003\.00\d\n/);
  expect(sb.info()).toMatchObject({ display: null, backend: 'wayland' });
});

it("the app sees the compositor's socket alone, as wayland-0, and no X at all", async () => {
  const report = join(sb.home, 'report.txt');
  expect(await until(() => existsSync(report))).toBe(true);
  const r = Object.fromEntries(
    readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  expect(r.wayland).toMatch(/\/wayland-0$/);
  expect(r.socket).toBe('yes');
  expect(r.display).toBe('none');
  expect(r.x.trim()).toBe('none');
  expect(r.qt).toBe('wayland');
  expect(r.session).toBe('wayland');
  expect(r.run.split(' ')).toContain('wayland-0');
  expect(r.run).not.toContain('ipc.sock');
  expect(r.own).toBe('hidden');
  expect(r.vnc).toBe('hidden');
});

it('its compositor draws in software (pixman): the app has no render node inside', () => {
  const sway = (sb as unknown as { procs: { name: string; proc: { pid: number } }[] }).procs.find((p) => p.name === 'sway')!;
  const env = readFileSync(`/proc/${sway.proc.pid}/environ`, 'utf8').split('\0');
  expect(env).toContain('WLR_RENDERER=pixman');
});

it('a picture of the screen is a PNG at its size', async () => {
  const png = await sb.screen!.screenshot();
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 600]);
});
