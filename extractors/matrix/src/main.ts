/**
 * dither-chat Matrix adapter. Spawned by the hub as
 *   bun extractors/matrix/src/main.ts
 * with DITHER_* in the environment (see packages/chat-protocol/src/adapter.ts).
 *
 * Config (DITHER_ACCOUNT_CONFIG): { "homeserver": "https://matrix.org", "userId"?: "@u:server" }
 * Secret ($DITHER_ACCOUNT_DIR/secret.json): { password?, accessToken?, deviceId?, userId?, e2ee? }
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHub } from '@dither-chat/protocol/client';
import { MatrixAdapter } from './adapter.ts';

// One syncer per account. If another adapter process for this account is
// alive (a restart that overlapped with the previous process, or an adapter
// orphaned by a hub crash), wait in standby instead of syncing alongside it,
// and take over when it is gone. Standby never kills the other process: an
// extra exit would make the hub's supervisor schedule yet another start.
const accountId = process.env.DITHER_ACCOUNT_ID ?? '';
const lockFile = join(process.env.DITHER_ACCOUNT_DIR ?? '.', 'adapter.pid');
const parent = process.ppid;
// A manager whose extractors outlive it (its docs/supervisor.md) restarts without taking us down, and the next one
// adopts us: its going is no reason to exit (the link's own timeout ends us if no manager comes back).
const outlives = !!process.env.DITHER_MANAGER_GONE_EXIT_S;
const orphaned = () => !outlives && process.ppid !== parent;

const lockHolder = () => {
  try {
    return Number(readFileSync(lockFile, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
};
const isSibling = (pid: number) => {
  if (!pid || pid === process.pid) return false;
  try {
    // dither-chat's copy (packages/adapter-matrix) and this one (extractors/matrix) are siblings too.
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('adapter-matrix') && !cmd.includes('extractors/matrix')) return false;
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DITHER_ACCOUNT_ID=${accountId}`);
  } catch {
    return false;
  }
};

if (isSibling(lockHolder())) {
  const other = lockHolder();
  console.log(`[warn] adapter pid ${other} is already running for ${accountId}; standing by until it exits`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  while (isSibling(lockHolder())) {
    if (orphaned()) process.exit(0);
    await Bun.sleep(2_000);
  }
  console.log('[info] previous adapter is gone; taking over');
}
writeFileSync(lockFile, String(process.pid), { mode: 0o600 });

const adapter = new MatrixAdapter();
const hub = linkHub({
  onConnect: () => adapter.onConnect(),
  onCommand: (cmd) => adapter.command(cmd),
  onShutdown: () => adapter.shutdown(),
});
adapter.start(hub);

process.on('unhandledRejection', (e) => console.log('[error] unhandled rejection', String((e as any)?.stack ?? e)));

setInterval(() => {
  // The hub that spawned us died (it starts a fresh adapter when it comes back; not so a manager we outlive), or
  // another adapter took the lock.
  const holder = lockHolder();
  const reason = orphaned() ? 'the process that started it went away' : holder !== process.pid && isSibling(holder) ? `adapter pid ${holder} took over` : null;
  if (!reason) return;
  console.log(`[info] ${reason}; exiting`);
  void adapter.shutdown().finally(() => process.exit(0));
}, 3_000);
