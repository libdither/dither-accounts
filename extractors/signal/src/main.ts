/**
 * Signal adapter entry point. Spawned by the hub as
 * `bun extractors/signal/src/main.ts` with DITHER_* env (protocol/adapter.ts).
 *
 * Optional account config (DITHER_ACCOUNT_CONFIG):
 *   deviceName           name shown in Signal → Linked devices (default "dither-chat")
 *   trustNewIdentities   signal-cli --trust-new-identities (default "always", like the official
 *                        apps, which keep receiving from contacts whose safety number changed)
 * Environment:
 *   SIGNAL_CLI_BIN       signal-cli to run (else PATH, else `nix build nixpkgs#signal-cli`)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHub } from '@dither-chat/protocol/client';
import { SignalAdapter } from './adapter.ts';
import { resolveSignalCli } from './cli.ts';

let adapter: SignalAdapter | null = null;

const hub = linkHub({
  onConnect: () => adapter?.onHubConnect(),
  onCommand: (cmd) => {
    if (!adapter) throw new Error('adapter is starting');
    return adapter.command(cmd);
  },
  onShutdown: async () => {
    await adapter?.shutdown();
  },
});

const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

process.on('unhandledRejection', (e: any) => log('error', `unhandled rejection: ${e?.stack ?? e}`));
process.on('SIGHUP', async () => {
  await adapter?.shutdown();
  process.exit(0);
});

await takeOverAccountDir(hub.accountDir);

adapter = new SignalAdapter(
  {
    emit: (ev) => hub.emit(ev),
    log,
    accountDir: hub.accountDir,
    config: hub.config,
    secret: () => hub.secret(),
    saveSecret: (v) => hub.saveSecret(v),
  },
  { signalCli: () => resolveSignalCli(join(hub.accountDir, 'signal-cli.bin'), log) },
);
await adapter.start();

/**
 * One adapter per account dir. If the hub died without stopping us, a new hub
 * spawns a second adapter for the same account; the old one would keep its
 * signal-cli (and the account lock). Stop any previous instance first.
 */
async function takeOverAccountDir(dir: string) {
  const pidFile = join(dir, 'adapter.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (pid && pid !== process.pid) {
      let cmd = '';
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {}
      if (cmd.includes('adapter-signal')) {
        log('warn', `stopping a previous Signal adapter for this account (pid ${pid})`);
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
        for (let i = 0; i < 100 && existsSync(`/proc/${pid}`); i++) await Bun.sleep(100);
        try {
          if (existsSync(`/proc/${pid}`)) process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
  writeFileSync(pidFile, String(process.pid));
}
