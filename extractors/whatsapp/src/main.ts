/**
 * WhatsApp adapter entry point. Spawned by the hub as
 * `bun extractors/whatsapp/src/main.ts` with DITHER_* env (protocol/adapter.ts).
 *
 * Optional account config (DITHER_ACCOUNT_CONFIG):
 *   deviceName   name shown in WhatsApp → Linked devices (default "dither-chat")
 *   platform     device type WhatsApp is told (DESKTOP, CHROME, FIREFOX, ...; default DESKTOP)
 *   debug        true: the bridge logs whatsmeow's debug output to adapter.log
 * Environment:
 *   WHATSAPP_BRIDGE_BIN   bridge to run (else dither-wa-bridge on PATH, else a nix build of bridge/)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHub } from '@dither-chat/protocol/client';
import { WhatsAppAdapter } from './adapter.ts';
import { resolveBridge } from './bridge.ts';

let adapter: WhatsAppAdapter | null = null;

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

adapter = new WhatsAppAdapter(
  { emit: (ev) => hub.emit(ev), log, accountDir: hub.accountDir, config: hub.config },
  { bridge: () => resolveBridge(hub.accountDir, log) },
);
await adapter.start();

/**
 * One adapter per account dir: two linked-device connections with one session make WhatsApp close
 * one ("stream replaced") and look like a broken client. If the hub died without stopping us, stop
 * the previous adapter (and so its bridge) before starting.
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
      if (cmd.includes('adapter-whatsapp')) {
        log('warn', `stopping a previous WhatsApp adapter for this account (pid ${pid})`);
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
