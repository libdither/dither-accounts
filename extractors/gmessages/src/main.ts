/**
 * Google Messages extractor entry point. Started by the manager as `bun extractors/gmessages/src/main.ts` with the
 * DITHER_* environment (chat-protocol adapter.ts).
 *
 * Account config (DITHER_ACCOUNT_CONFIG), all optional:
 *   pairing          'qr' (default) or 'google': with 'google' and no cookies yet, it asks for them instead of a QR code
 *   initialChats     conversations listed on connect (25)
 *   initialMessages  messages fetched for a conversation the first time it is seen (20)
 *   debug            true: the bridge logs libgm's debug output to adapter.log
 *   proxy            reach Google through this proxy (http://, https:// or socks5://host:port)
 *   pingMinutes      how often the phone is pinged (20, as mautrix-gmessages: more often drains its battery)
 *   deviceName       what the phone lists this pairing as under Device pairing (default "dither-accounts")
 * secret.json:
 *   cookies          a Google account's messages.google.com cookies, to pair by Google account (dropped once paired)
 *   session          the pairing (libgm's AuthData), written by the extractor
 * Environment:
 *   GMESSAGES_BRIDGE_BIN   bridge to run (else dither-gm-bridge on PATH, else a nix build of bridge/)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHub } from '@dither-chat/protocol/client';
import { GMessagesAdapter } from './adapter.ts';
import { resolveBridge } from './bridge.ts';

let adapter: GMessagesAdapter | null = null;

const hub = linkHub({
  onConnect: () => adapter?.onHubConnect(),
  onCommand: (cmd) => {
    if (!adapter) throw new Error('the extractor is starting');
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

adapter = new GMessagesAdapter(
  { emit: (ev) => hub.emit(ev), log, accountDir: hub.accountDir, config: hub.config, secret: () => hub.secret(), saveSecret: (v) => hub.saveSecret(v) },
  { bridge: () => resolveBridge(hub.accountDir, log) },
);
await adapter.start();

/**
 * One extractor per account dir: two sessions on one pairing make Google Messages move between them ("open in
 * another browser"). If a previous one was left running, stop it (and so its bridge) first.
 */
async function takeOverAccountDir(dir: string) {
  const pidFile = join(dir, 'extractor.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (pid && pid !== process.pid) {
      let cmd = '';
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {}
      if (cmd.includes('extractors/gmessages/src/main.ts')) {
        log('warn', `stopping a previous Google Messages extractor for this account (pid ${pid})`);
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
