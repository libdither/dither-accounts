/**
 * The native-app sandbox on each Xvnc backend (tigervnc, kasmvnc: packages/browser/src/screen.ts), as an
 * X-only app sees it: its display's path socket bound in and nothing else of the machine's X (no abstract socket under
 * pasta), DISPLAY set, the live view on its socket with the Xvnc holding no inet socket, and xdotool's clicks and keys
 * arriving in the app. xev stands in for the app. Skipped without the native-app sandbox, pasta, xev or that Xvnc.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISPLAY_BINS, pickFreeDisplay } from '@dither-accounts/browser';
import { hasBackend } from '../../../test/needs.ts';
import { AppSandbox } from '../src/sandbox.ts';
import { BINS, resolveBin, tryBin } from '../src/bins.ts';
import { inetSockets, rfbBanner } from '../../browser/test/inet.ts';
import { sandbox, satellite, why } from '../../../test/needs.ts';

const pasta = sandbox && !!tryBin(BINS.pasta, () => {});
const ok = why('an X app in the native-app sandbox (bubblewrap, pasta, xev)', sandbox && satellite && pasta);
const BACKENDS = ok ? (['tigervnc', 'kasmvnc'] as const).filter((b) => why(`${b}'s Xvnc`, hasBackend(b))) : [];

const root = mkdtempSync(join(tmpdir(), 'dacc-sbx-xvnc-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const backend of BACKENDS) {
  describe(`an X app on ${backend}`, () => {
    test(
      'sees only its display, gets the clicks and keys; the live view answers on its socket and its Xvnc holds no inet socket',
      async () => {
        const dir = join(root, backend, 'app');
        const sh = resolveBin(BINS.sh, () => {});
        const xev = resolveBin({ name: 'xev', env: 'XEV_BIN', nix: 'xorg.xev' }, () => {});
        const appDir = join(root, backend, 'bin');
        mkdirSync(appDir, { recursive: true });
        writeFileSync(
          join(appDir, 'app.sh'),
          `{ echo "display=$DISPLAY"; echo "x=$(ls /tmp/.X11-unix | tr '\\n' ' ')"; n=0; while read -r l; do case "$l" in *@/tmp/.X11-unix*) n=$((n+1));; esac; done < /proc/net/unix; echo "abstract=$n"; } > "$HOME/env.txt"\nexec stdbuf -oL ${xev} -name xvnc-xev -geometry 800x600+0+0 -event keyboard -event button > "$HOME/xev.log"\n`,
        );
        const free = await pickFreeDisplay(undefined, [], backend);
        const said: string[] = [];
        const sb = new AppSandbox({ dir, display: free, width: 800, height: 600, command: [sh, join(appDir, 'app.sh')], roBinds: [appDir], log: (l, m) => said.push(`${l} ${m}`), onEvent: () => {} });
        const until = async (f: () => boolean, ms = 30_000) => {
          const end = Date.now() + ms;
          while (!f()) {
            if (Date.now() > end) throw new Error(`not there within ${ms} ms; the sandbox said:\n${said.slice(-30).join('\n')}`);
            await Bun.sleep(50);
          }
        };
        try {
          const t0 = performance.now();
          await sb.start().catch(async (e) => {
            // What the display said comes out as it stops (KasmVNC keeps its log in a buffer until then).
            await sb.stop();
            await Bun.sleep(200);
            throw new Error(`${(e as Error).message} (${((performance.now() - t0) / 1000).toFixed(1)} s after the start); the sandbox said:\n${said.slice(-60).join('\n')}`);
          });
          expect(sb.info()).toMatchObject({ backend, display: free.display });
          expect(await rfbBanner(sb.vncSocket)).toMatch(/^RFB 003\.00\d\n/);
          const env = join(sb.home, 'env.txt');
          await until(() => existsSync(env) && readFileSync(env, 'utf8').includes('abstract='));
          const r = Object.fromEntries(readFileSync(env, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
          expect(r.display).toBe(`:${free.display}`);
          expect(r.x!.trim()).toBe(`X${free.display}`);
          // pasta is there (the file skips without it): the app's network namespace is its own, so it sees no abstract X socket.
          expect(sb.info().network).toBe('pasta');
          expect(r.abstract).toBe('0');
          const log = join(sb.home, 'xev.log');
          await until(() => existsSync(log));
          // xev's window on the screen (mapped and viewable), then one click: it lands in it.
          const xdotool = resolveBin(DISPLAY_BINS.xdotool, () => {});
          const found = Bun.spawnSync(['timeout', '20', xdotool, 'search', '--sync', '--onlyvisible', '--name', 'xvnc-xev'], { env: { ...process.env, ...sb.screen!.clientEnv() } });
          expect(found.stdout.toString().trim()).toMatch(/^\d+/);
          await sb.screen!.click(400, 300);
          await until(() => /ButtonPress event/.test(readFileSync(log, 'utf8')));
          await sb.screen!.type('qZ');
          await until(() => /keysym 0x71, q\)[\s\S]*keysym 0x5a, Z\)/.test(readFileSync(log, 'utf8')));
          // The Xvnc: one process of the sandbox's, no TCP or UDP socket.
          const { procs } = JSON.parse(readFileSync(join(dir, 'sandbox.json'), 'utf8')) as { procs: { name: string; pid: number }[] };
          const xvnc = procs.filter((p) => p.name === 'Xvnc');
          expect(xvnc.length).toBe(1);
          expect(inetSockets(xvnc[0]!.pid)).toEqual([]);
        } finally {
          await sb.stop();
        }
      },
      90_000,
    );
  });
}
