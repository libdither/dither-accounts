/**
 * Telegram extractor entry point, started by the manager as `bun extractors/telegram/src/main.ts` with DITHER_* in the
 * environment (packages/chat-protocol/src/adapter.ts).
 *
 * Config (DITHER_ACCOUNT_CONFIG): { apiId: "1234567", testDc?: "yes", deviceName?: "dither-accounts", maxDialogs?: 2000,
 *   signIn?: "qr" | "desktop", desktopSession?: "own" | "shared" }
 * Secret ($DITHER_ACCOUNT_DIR/secret.json): { apiHash, session?, userId? }; the session string after the first sign-in.
 *   Through Telegram Desktop also sessionMode ("own" | "shared"), desktopKey (which key it came from: a hash, not the
 *   key) and desktopEnded; a shared session is read from Telegram Desktop's tdata each start, never kept here.
 * Environment:
 *   TELEGRAM_FAKE=1           a fake Telegram (src/fake.ts) instead of Telegram's servers: tests, scripts/verify-telegram.ts
 *   TELEGRAM_LOG_LEVEL        mtcute's own log level (1 error … 4 debug; default 2)
 *   DITHER_TELEGRAM_DESKTOP=1 the sign-in through Telegram Desktop is offered and runs (off by default; docs/telegram.md)
 *   TELEGRAM_DESKTOP_FAKE=1   the fake Telegram Desktop (test/fake-desktop.ts) in the sandbox, with TELEGRAM_FAKE
 *   TELEGRAM_DESKTOP_BIN      Telegram Desktop's binary (else PATH, else nix build nixpkgs#telegram-desktop)
 *   TELEGRAM_DESKTOP_NETWORK  pasta (default), host or none: the sandbox's network
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHub } from '@dither-chat/protocol/client';
import { TelegramAdapter } from './adapter.ts';
import type { TgBackend } from './backend.ts';
import type { DesktopSession } from './desktop.ts';
import { clientProfile, TELEGRAM_DESKTOP } from './profile.ts';

const dir = process.env.DITHER_ACCOUNT_DIR ?? '.';
const accountId = process.env.DITHER_ACCOUNT_ID ?? '';
const fake = process.env.TELEGRAM_FAKE === '1';

// One client per session, ever: two connections on one auth key make Telegram end it (AUTH_KEY_DUPLICATED). If
// another extractor process for this account is alive (a restart that overlapped, an orphan), wait for it to go.
const pidFile = join(dir, 'adapter.pid');
const sibling = (pid: number) => {
  if (!pid || pid === process.pid) return false;
  try {
    if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('extractors/telegram')) return false;
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DITHER_ACCOUNT_ID=${accountId}`);
  } catch {
    return false;
  }
};
const holder = () => {
  try {
    return Number(readFileSync(pidFile, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
};
if (existsSync(pidFile) && sibling(holder())) {
  console.log(`[warn] extractor pid ${holder()} already runs this account; waiting until it exits`);
  const leave = () => process.exit(0);
  process.on('SIGTERM', leave);
  while (sibling(holder())) await Bun.sleep(1000);
  process.off('SIGTERM', leave);
}
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

let adapter: TelegramAdapter | null = null;
const hub = linkHub({
  onConnect: () => adapter?.onHubConnect(),
  onCommand: (cmd) => {
    if (!adapter) throw new Error('the extractor is starting');
    // The manager sends the call's own id as `rid`, so an op input named `id` (notify.mute, desktop.fetch) arrives as
    // sent; the chat link answers by `id`. The adapter gets the input as sent, and the answer goes back by `rid`.
    const rid = (cmd as { rid?: unknown }).rid;
    const input = { ...cmd };
    if (typeof rid === 'string') (cmd as { id?: string }).id = rid;
    return adapter.command(input);
  },
  onShutdown: async () => {
    await adapter?.shutdown();
  },
});
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);
process.on('unhandledRejection', (e: any) => log('error', `unhandled rejection: ${e?.stack ?? e}`));

let fakeBackend: import('./fake.ts').FakeTelegram | null = null;
const yes = (v: unknown) => /^(1|true|yes)$/i.test(String(v ?? ''));
const fakeTelegram = () => {
  const { FakeTelegram } = require('./fake.ts') as typeof import('./fake.ts');
  return (fakeBackend ??= new FakeTelegram({ dir: hub.accountDir, control: true, log: (l, m) => log(l, m) }));
};

// Signed in through Telegram Desktop in the account's sandbox (desktop.ts); only where the manager offers it.
const desktopWanted = String(hub.config.signIn ?? '') === 'desktop';
const desktopOn = process.env.DITHER_TELEGRAM_DESKTOP === '1';
let desktop: DesktopSession | null = null;
if (desktopWanted && desktopOn) {
  const { DesktopSession } = require('./desktop.ts') as typeof import('./desktop.ts');
  const network = process.env.TELEGRAM_DESKTOP_NETWORK;
  desktop = new DesktopSession({
    accountDir: hub.accountDir,
    log,
    emit: (ev) => hub.emit(ev as never),
    onChange: () => adapter?.desktopChanged(),
    fake: process.env.TELEGRAM_DESKTOP_FAKE === '1',
    ...(network === 'pasta' || network === 'host' || network === 'none' ? { network } : {}),
    ...(process.env.TELEGRAM_DESKTOP_POLL_MS ? { pollMs: Number(process.env.TELEGRAM_DESKTOP_POLL_MS) } : {}),
  });
}
const testMode = yes(hub.config.testDc);
const profileFor = (apiId: number) => clientProfile(apiId, { deviceName: String(hub.config.deviceName || 'dither-accounts'), bin: desktop?.bin });
const mtLogLevel = Number(process.env.TELEGRAM_LOG_LEVEL) || 2;

adapter = new TelegramAdapter(
  {
    emit: (ev) => hub.emit(ev),
    log,
    accountDir: hub.accountDir,
    config: hub.config,
    secret: () => hub.secret(),
    saveSecret: (v) => hub.saveSecret(v),
  },
  {
    fake,
    maxDialogs: Number(hub.config.maxDialogs) || undefined,
    healthEveryMs: Number(process.env.TELEGRAM_HEALTH_MS) || undefined,
    backend: (creds): TgBackend => {
      if (fake) return fakeTelegram();
      const { MtcuteBackend } = require('./mtcute.ts') as typeof import('./mtcute.ts');
      return new MtcuteBackend({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        dir: hub.accountDir,
        testMode,
        // On Telegram Desktop's api_id, as Telegram Desktop (whose app id it is); on the account's own, its device name.
        initConnection: profileFor(creds.apiId),
        log: (l, m) => log(l, m),
        logLevel: mtLogLevel,
      });
    },
    ...(desktop
      ? {
          desktop: {
            session: desktop,
            deskClient: (key) => {
              if (fake) return fakeTelegram().desktopClient(key);
              const { MtcuteDeskClient } = require('./mtcute.ts') as typeof import('./mtcute.ts');
              return new MtcuteDeskClient(key, { ...TELEGRAM_DESKTOP, testMode, profile: profileFor(TELEGRAM_DESKTOP.apiId), log: (l, m) => log(l, m), logLevel: mtLogLevel });
            },
            sharedSession: async (key) => {
              if (fake) return (require('./fake.ts') as typeof import('./fake.ts')).FakeTelegram.keySession(key);
              const { sessionFromKey } = require('./mtcute.ts') as typeof import('./mtcute.ts');
              return sessionFromKey(key, testMode);
            },
            ...(process.env.TELEGRAM_DESKTOP_RETRY_MS ? { retryMs: Number(process.env.TELEGRAM_DESKTOP_RETRY_MS) } : {}),
          },
        }
      : {}),
  },
);
if (desktopWanted && !desktopOn) {
  // Added through Telegram Desktop where this manager does not offer it (yet): say so rather than show a QR code.
  hub.emit({ t: 'hello', network: 'telegram', version: '0.1.0', capabilities: [] });
  hub.emit({ t: 'status', status: 'error', attention: { kind: 'unknown', message: 'This account signs in through Telegram Desktop, which this manager does not offer yet (DITHER_TELEGRAM_DESKTOP=1; docs/telegram.md).' }, layers: [{ name: 'sandbox', state: 'off', note: 'the Telegram Desktop sign-in is off on this manager' }] });
} else {
  await adapter.start();
}
