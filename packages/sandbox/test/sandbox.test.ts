/**
 * The sandbox for real: Xvfb on a free display with x11vnc speaking RFB on its Unix socket (and on no port), a private
 * bus, and a small app under bubblewrap (pasta's network when there is pasta) that reports what it can see, opens a
 * link through xdg-open and saves a download. What it must not see: the user's home, the host's X sockets (abstract
 * ones included, under pasta), the host's loopback, the extractor's environment, its own live view's socket.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickFreeDisplay } from '@dither-accounts/browser';
import { mergeMimeapps } from '../src/sandbox.ts';
import { AppSandbox, type SandboxEvent } from '../src/sandbox.ts';
import { BINS, resolveBin } from '../src/bins.ts';
import { sandbox, why } from '../../../test/needs.ts';
import { inetSockets, rfbBanner, x11vncs } from '../../browser/test/inet.ts';

const ok = why('the native-app sandbox (bubblewrap, Xvfb, x11vnc, dbus)', sandbox);
const it = test.skipIf(!ok);

const root = mkdtempSync(join(tmpdir(), 'dacc-sbx-'));
const dir = join(root, 'acct', 'desktop');
const events: SandboxEvent[] = [];
let sb: AppSandbox;

const APP = `
out="$HOME/report.txt"
{
  echo "uid=$(id -u)"
  echo "home=$(ls -A /home | tr '\\n' ' ')"
  echo "userhome=$([ -e ${JSON.stringify(homedir())} ] && echo visible || echo hidden)"
  echo "bus=$([ -S "$XDG_RUNTIME_DIR/bus" ] && echo yes || echo no)"
  echo "x=$(ls /tmp/.X11-unix | tr '\\n' ' ')"
  n=0; while read -r l; do case "$l" in *@/tmp/.X11-unix*) n=$((n+1));; esac; done < /proc/net/unix; echo "abstract=$n"
  echo "token=\${DITHER_ADAPTER_TOKEN:-none}"
  c=0; for v in $(tr '\\0' ' ' < /proc/1/environ 2>/dev/null); do case "$v" in DITHER_*) c=$((c+1));; esac; done; echo "pid1token=$c"
  echo "path=$PATH"
  echo "theme=$QT_QPA_PLATFORMTHEME"
  echo "vnc=$([ -e ${JSON.stringify(join(dir, 'vnc.sock'))} ] || [ -e ${JSON.stringify(dir)} ] && echo visible || echo hidden)"
} > "$out.tmp"
mv "$out.tmp" "$out"
xdg-open 'https://example.org/from-app?q=1' && echo "opened=yes" >> "$out"
mkdir -p "$HOME/Downloads/App"
printf 'hello' > "$HOME/Downloads/App/report.txt"
exec sleep 600
`;

beforeAll(async () => {
  if (!ok) return;
  const free = await pickFreeDisplay();
  const sh = resolveBin(BINS.sh, () => {});
  const appDir = join(root, 'app');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'app.sh'), APP, { mode: 0o755 });
  process.env.DITHER_ADAPTER_TOKEN = 'secret-token-for-the-test';
  sb = new AppSandbox({
    dir,
    display: free.display,
    width: 800,
    height: 600,
    command: [sh, join(appDir, 'app.sh')],
    roBinds: [appDir],
    settleMs: 300,
    log: () => {},
    onEvent: (ev) => events.push(ev),
  });
  await sb.start();
}, 120_000);

afterAll(async () => {
  if (!ok) return;
  await sb?.stop();
  delete process.env.DITHER_ADAPTER_TOKEN;
  rmSync(root, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(100);
  return ok();
};

it('the live view speaks RFB on its own socket (0600, in the 0700 sandbox directory), and on no port', async () => {
  expect(sb.vncSocket).toBe(join(dir, 'vnc.sock'));
  expect(sb.info().vncSocket).toBe(sb.vncSocket);
  expect(lstatSync(sb.vncSocket).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(await rfbBanner(sb.vncSocket)).toMatch(/^RFB 003\.00\d\n/);
  const pids = x11vncs(readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map(Number)).filter((p) => {
    try {
      return readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').includes(sb.vncSocket);
    } catch {
      return false;
    }
  });
  expect(pids.length).toBe(1);
  expect(inetSockets(pids[0]!)).toEqual([]);
}, 20_000);

it('the app sees only its sandbox', async () => {
  const report = join(sb.home, 'report.txt');
  expect(await until(() => existsSync(report) && readFileSync(report, 'utf8').includes('opened='))).toBe(true);
  const r = Object.fromEntries(
    readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  expect(r.uid).toBe(String(process.getuid!()));
  expect(r.home.trim()).toBe('user');
  expect(r.userhome).toBe('hidden');
  expect(r.bus).toBe('yes');
  expect(r.x.trim()).toBe(`X${sb.info().display}`);
  expect(r.token).toBe('none');
  expect(r.pid1token).toBe('0');
  expect(r.path.startsWith('/run/dither/bin:/nix/store/')).toBe(true);
  expect(r.theme).toBe('xdgdesktopportal');
  expect(r.vnc).toBe('hidden');
  if (sb.info().network === 'pasta') expect(r.abstract).toBe('0');
  expect(r.opened).toBe('yes');
  expect(await until(() => sb.info().app === 'running')).toBe(true);
}, 30_000);

it('a link the app opens and a file it saves arrive as events', async () => {
  expect(await until(() => events.some((e) => e.t === 'link') && events.some((e) => e.t === 'download'))).toBe(true);
  const link = events.find((e) => e.t === 'link') as Extract<SandboxEvent, { t: 'link' }>;
  expect(link).toMatchObject({ url: 'https://example.org/from-app?q=1', via: 'xdg-open' });
  const dl = events.find((e) => e.t === 'download') as Extract<SandboxEvent, { t: 'download' }>;
  expect(dl.download).toMatchObject({ path: 'App/report.txt', name: 'report.txt', size: 5, mime: 'text/plain' });
  expect(sb.listDownloads().map((d) => d.id)).toEqual([dl.download.id]);
  expect(readFileSync(sb.downloadPath(dl.download.id)!, 'utf8')).toBe('hello');
  expect(sb.downloadPath('nope')).toBeNull();
  expect(events.some((e) => e.t === 'app' && e.state === 'running')).toBe(true);
}, 30_000);

it('the app exits on stopApp and comes back on startApp', async () => {
  await sb.stopApp();
  expect(await until(() => events.some((e) => e.t === 'app' && e.state === 'exited'))).toBe(true);
  expect(sb.appAlive).toBe(false);
  sb.startApp();
  expect(await until(() => sb.info().app === 'running')).toBe(true);
}, 30_000);

test('mimeapps.list keeps what the app wrote and points links at the shim', () => {
  const p = join(root, 'mimeapps.list');
  writeFileSync(p, '[Added Associations]\nx-scheme-handler/tg=org.telegram.desktop.desktop\n\n[Default Applications]\nx-scheme-handler/tg=org.telegram.desktop.desktop\nx-scheme-handler/http=firefox.desktop\n');
  mergeMimeapps(p, ['x-scheme-handler/http', 'x-scheme-handler/https'], 'dither-open.desktop');
  expect(readFileSync(p, 'utf8')).toBe(
    '[Added Associations]\nx-scheme-handler/tg=org.telegram.desktop.desktop\n\n[Default Applications]\nx-scheme-handler/tg=org.telegram.desktop.desktop\nx-scheme-handler/http=dither-open.desktop\nx-scheme-handler/https=dither-open.desktop\n',
  );
  const q = join(root, 'empty.list');
  mergeMimeapps(q, ['x-scheme-handler/http'], 'dither-open.desktop');
  expect(readFileSync(q, 'utf8')).toBe('[Default Applications]\nx-scheme-handler/http=dither-open.desktop\n');
});
