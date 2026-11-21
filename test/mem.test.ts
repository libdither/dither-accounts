import { describe, expect, test } from 'bun:test';
import { groupBrowsers, procType, type Proc } from '../scripts/mem.ts';

const CHROME = '/opt/chromium/chromium';
const P = (pid: number, ppid: number, ...args: string[]): Proc => ({ pid, ppid, args });

describe('scripts/mem.ts', () => {
  test('puts every Chromium process with the root browser it descends from, by profile', () => {
    const procs = [
      P(10, 1, 'bun', '/srv/release/extractors/proton/src/main.ts'),
      P(11, 10, CHROME, '--user-data-dir=/data/accounts/acc-1/profile', 'https://mail.example.com/'),
      P(12, 11, CHROME, '--type=zygote'),
      P(13, 12, CHROME, '--type=zygote'),
      P(14, 13, CHROME, '--type=renderer', '--renderer-client-id=5'),
      P(15, 13, CHROME, '--type=renderer', '--extension-process'),
      P(16, 11, CHROME, '--type=gpu-process'),
      P(17, 11, CHROME, '--type=utility', '--utility-sub-type=network.mojom.NetworkService'),
      P(20, 1, 'bun', '/srv/release/extractors/discord/src/main.ts'),
      P(21, 20, CHROME, '--user-data-dir=/data/accounts/acc-2/profile'),
      P(22, 21, CHROME, '--type=renderer'),
      P(30, 1, CHROME, '--type=renderer'), // some other browser's, no root here
      P(31, 1, 'Xvfb', ':80'),
    ];
    const pss: Record<number, number> = { 11: 100, 12: 5, 13: 5, 14: 300, 15: 20, 16: 30, 17: 25, 21: 90, 22: 200, 30: 999 };
    const out = groupBrowsers(procs, (pid) => pss[pid] ?? 0);
    expect(out.map((b) => [b.account, b.kind, b.pssKiB])).toEqual([
      ['acc-1', 'proton', 485],
      ['acc-2', 'discord', 290],
    ]);
    expect(out[0]!.byType).toEqual({
      browser: { count: 1, pssKiB: 100 },
      zygote: { count: 2, pssKiB: 10 },
      renderer: { count: 1, pssKiB: 300 },
      extension: { count: 1, pssKiB: 20 },
      gpu: { count: 1, pssKiB: 30 },
      'utility:network': { count: 1, pssKiB: 25 },
    });
  });

  test('names process types from their switches', () => {
    expect(procType(['x'])).toBe('browser');
    expect(procType(['x', '--type=utility', '--utility-sub-type=audio.mojom.AudioService'])).toBe('utility:audio');
    expect(procType(['x', '--type=crashpad-handler'])).toBe('crashpad');
  });
});
