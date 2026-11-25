/**
 * The native-app sandbox on each Xvnc backend (tigervnc, kasmvnc, turbovnc: packages/browser/src/screen.ts), as an
 * X-only app sees it: its display's path socket bound in and nothing else of the machine's X (no abstract socket under
 * pasta), DISPLAY set, the live view on its socket with the Xvnc holding no inet socket, and xdotool's clicks and keys
 * arriving in the app. xev stands in for the app. Skipped without the native-app sandbox, pasta, xev or that Xvnc.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISPLAY_BINS, pickFreeDisplay } from '@dither-accounts/browser';
import { AppSandbox } from '../src/sandbox.ts';
import { BINS, resolveBin, tryBin } from '../src/bins.ts';
import { inetSockets, rfbBanner } from '../../browser/test/inet.ts';
import { sandbox, satellite, why } from '../../../test/needs.ts';

const pasta = sandbox && !!tryBin(BINS.pasta, () => {});
const ok = why('an X app in the native-app sandbox (bubblewrap, pasta, xev)', sandbox && satellite && pasta);
const BACKENDS = ok ? (['tigervnc', 'kasmvnc', 'turbovnc'] as const).filter((b) => why(`${b}'s Xvnc`, !!tryBin(DISPLAY_BINS[b], () => {}))) : [];

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
          await sb.start();
          expect(sb.info()).toMatchObject({ backend, display: free.display });
          expect(await rfbBanner(sb.vncSocket)).toMatch(/^RFB 003\.00\d\n/);
          const env = join(sb.home, 'env.txt');
          await until(() => existsSync(env) && readFileSync(env, 'utf8').includes('abstract='));
          const r = Object.fromEntries(readFileSync(env, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
          expect(r.display).toBe(`:${free.display}`);
          expect(r.x!.trim()).toBe(`X${free.display}`);
          if (sb.info().network === 'pasta') expect(r.abstract).toBe('0');
          const log = join(sb.home, 'xev.log');
          // The window mapped (xev says so on Expose... only with -event exposure; a click landing is the proof).
          await until(() => existsSync(log));
          for (let end = Date.now() + 20_000; !/ButtonPress event/.test(readFileSync(log, 'utf8')); ) {
            if (Date.now() > end) throw new Error(`no ButtonPress; the sandbox said:\n${said.slice(-30).join('\n')}`);
            await sb.screen!.click(400, 300);
            await Bun.sleep(300);
          }
          await sb.screen!.type('qZ');
          await until(() => /keysym 0x71, q\)[\s\S]*keysym 0x5a, Z\)/.test(readFileSync(log, 'utf8')));
          // The Xvnc: one process of the sandbox's, no TCP or UDP socket.
          const xvnc = (sb as any).procs?.find?.((p: { name: string }) => p.name === 'Xvnc')?.proc?.pid as number | undefined;
          if (xvnc) expect(inetSockets(xvnc)).toEqual([]);
        } finally {
          await sb.stop();
        }
      },
      90_000,
    );
  });
}
