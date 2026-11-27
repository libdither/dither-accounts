import { describe, expect, test } from 'bun:test';
import { chromiumType, groupAccounts, procType, type Proc } from '../scripts/mem.ts';

const CHROME = '/opt/chromium/chromium';
const DATA = '/data';
const P = (pid: number, ppid: number, args: string[], more: Partial<Proc> = {}): Proc => ({ pid, ppid, args, ...more });
const acct = (account: string, cgroup?: string): Partial<Proc> => ({ account, data: DATA, cgroup });

describe('scripts/mem.ts', () => {
  test('puts every process with the account whose environment it carries or descends from, RAM and swap apart', () => {
    const scope = '/user.slice/app.slice/dither-accounts-x-acc-1-abc.scope';
    const procs = [
      P(5, 1, ['bun', '/srv/release/packages/manager/src/main.ts'], { data: DATA, cgroup: '/app.slice/dither-accounts.service' }),
      P(10, 5, ['bun', '/srv/release/extractors/proton/src/main.ts'], acct('acc-1', scope)),
      P(11, 10, [CHROME, '--user-data-dir=/data/accounts/acc-1/profile', 'https://mail.example.com/'], acct('acc-1', scope)),
      P(12, 11, [CHROME, '--type=zygote'], { cgroup: scope }),
      P(13, 12, [CHROME, '--type=zygote'], { cgroup: scope }),
      P(14, 13, [CHROME, '--type=renderer', '--renderer-client-id=5'], { cgroup: scope }),
      P(15, 13, [CHROME, '--type=renderer', '--extension-process'], { cgroup: scope }),
      P(16, 11, [CHROME, '--type=gpu-process'], { cgroup: scope }),
      P(17, 10, ['/nix/store/x-xvfb/bin/Xvfb', ':80'], acct('acc-1', scope)),
      // a crashpad handler that reparented to init, outside the scope
      P(18, 1, [CHROME, '--type=crashpad-handler', '--database=/data/accounts/acc-1/profile/Crash Reports'], {}),
      P(20, 5, ['bun', '/srv/release/extractors/signal/src/main.ts'], acct('acc-2', '/app.slice/dither-accounts-x-acc-2-def.scope')),
      P(21, 20, ['/nix/store/x-jdk/bin/java', '-classpath', '/nix/store/x-signal-cli/lib/*'], acct('acc-2')),
      // a native sandbox: bubblewrap cleared its environment, but it is in the account's scope
      P(22, 1, ['/nix/store/x-electron/libexec/electron/electron', '--type=renderer'], { cgroup: '/app.slice/dither-accounts-x-acc-2-def.scope' }),
      P(30, 1, [CHROME, '--user-data-dir=/tmp/someone-else'], { cgroup: '/app.slice/other.scope' }),
      P(31, 30, [CHROME, '--type=renderer'], { cgroup: '/app.slice/other.scope' }),
    ];
    const mem: Record<number, [number, number]> = { 5: [50, 0], 10: [20, 10], 11: [100, 50], 12: [5, 15], 13: [5, 15], 14: [300, 200], 15: [20, 30], 16: [30, 40], 17: [8, 2], 18: [1, 1], 20: [20, 5], 21: [100, 600], 22: [90, 10], 30: [999, 0], 31: [999, 0] };
    const out = groupAccounts(procs, (pid) => ({ pssKiB: mem[pid]?.[0] ?? 0, swapKiB: mem[pid]?.[1] ?? 0 }));
    expect(out.map((a) => [a.account, a.kind, a.data, a.pssKiB, a.swapKiB])).toEqual([
      ['acc-1', 'proton', DATA, 489, 363],
      ['acc-2', 'signal', DATA, 210, 615],
    ]);
    expect(out[0]!.byType).toEqual({
      extractor: { count: 1, pssKiB: 20, swapKiB: 10 },
      browser: { count: 1, pssKiB: 100, swapKiB: 50 },
      zygote: { count: 2, pssKiB: 10, swapKiB: 30 },
      renderer: { count: 1, pssKiB: 300, swapKiB: 200 },
      extension: { count: 1, pssKiB: 20, swapKiB: 30 },
      gpu: { count: 1, pssKiB: 30, swapKiB: 40 },
      Xvfb: { count: 1, pssKiB: 8, swapKiB: 2 },
      crashpad: { count: 1, pssKiB: 1, swapKiB: 1 },
    });
    expect(Object.keys(out[1]!.byType).sort()).toEqual(['electron:renderer', 'extractor', 'signal-cli']);
  });

  test('a control group two accounts share (a child launch, in the manager service) names neither', () => {
    const shared = '/app.slice/dither-accounts.service';
    const procs = [
      P(10, 1, ['bun', '/srv/extractors/x/src/main.ts'], acct('acc-1', shared)),
      P(20, 1, ['bun', '/srv/extractors/discord/src/main.ts'], acct('acc-2', shared)),
      P(30, 1, ['bun', '/srv/packages/manager/src/main.ts'], { cgroup: shared }),
    ];
    const out = groupAccounts(procs, () => ({ pssKiB: 1, swapKiB: 0 }));
    expect(out.map((a) => [a.account, a.procs.map((p) => p.pid)])).toEqual([
      ['acc-1', [10]],
      ['acc-2', [20]],
    ]);
  });

  test('names process types', () => {
    expect(chromiumType(['x'])).toBe('browser');
    expect(chromiumType(['x', '--type=utility', '--utility-sub-type=audio.mojom.AudioService'])).toBe('utility:audio');
    expect(chromiumType(['x', '--type=crashpad-handler'])).toBe('crashpad');
    expect(chromiumType(['/opt/chromium/chrome_crashpad_handler', '--monitor-self'])).toBe('crashpad');
    expect(procType(P(1, 0, ['/bin/x11vnc', '-display', ':80']))).toBe('x11vnc');
    expect(procType(P(1, 0, ['electron', '--type=gpu-process']))).toBe('electron:gpu');
  });
});
