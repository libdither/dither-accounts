/**
 * The real backend: mtcute (https://mtcute.dev, MIT), a pure-TypeScript MTProto client with Bun support, talking to
 * Telegram's servers with your api_id and api_hash.
 *
 * What it keeps, in the account directory:
 *   secret.json      the session string (auth key, DC, who): the only credential, written by the adapter
 *   telegram.sqlite  mtcute's state: update sequence numbers (so a restart catches up on what it missed), the peers it
 *                    has seen with their access hashes, its DC list. No auth key: those stay in memory, from the
 *                    session string.
 *
 * FLOOD_WAIT: mtcute sleeps through waits up to `floodSleepMs` (10 s here) and retries; longer ones reach the adapter's
 * pacer (pacer.ts) as errors.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryAuthKeysRepository, MemoryStorage, MemoryStorageDriver, SqliteStorage, TelegramClient, type tl } from '@mtcute/bun';
import type { BackendInfo, ConnState, DeskClient, DesktopKey, QrHandlers, SentCode, TgBackend, UpdateInfo, UploadSpec } from './backend.ts';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

export interface MtcuteOptions {
  apiId: number;
  apiHash: string;
  dir: string;
  testMode: boolean;
  deviceModel: string;
  appVersion: string;
  log: Log;
  /** mtcute's own log level: 1 error, 2 warn, 3 info, 4 debug. */
  logLevel?: number;
  /** initConnection's fields, whole (Telegram Desktop's, for its own key: desktopProfile). */
  initConnection?: InitConnection;
}

type InitConnection = Partial<Omit<tl.RawInitConnectionRequest, 'apiId' | 'query'>>;

const UPDATES_TYPES = new Set(['updates', 'updatesCombined', 'updateShort', 'updateShortMessage', 'updateShortChatMessage', 'updatesTooLong']);

/**
 * The updates a call's answer carries, for mtcute's sequence numbers: the answer itself, or the updates inside a join's
 * result (as mtcute's own joinChat feeds them) or inside messages.invitedUsers, what layer 232 answers
 * messages.createChat, messages.addChatUser and channels.inviteToChannel with (as mtcute 0.32's own createGroup and
 * addChatMembers feed them). Left out, the next update looks like a gap and mtcute catches up on what it already had.
 */
export function updatesIn(res: unknown): tl.TypeUpdates | null {
  const kind = res && typeof res === 'object' ? (res as { _: string })._ : '';
  if (UPDATES_TYPES.has(kind)) return res as tl.TypeUpdates;
  if (kind === 'messages.chatInviteJoinResultOk' || kind === 'messages.invitedUsers') {
    const u = (res as { updates?: { _?: string } }).updates;
    if (u && UPDATES_TYPES.has(u._ ?? '')) return u as tl.TypeUpdates;
  }
  return null;
}

export class MtcuteBackend implements TgBackend {
  private client: TelegramClient;
  private sqlitePath: string;
  private queue: UpdateInfo[] = [];
  private onUpdate: ((u: UpdateInfo) => void) | null = null;
  private dc: number | null = null;

  constructor(private o: MtcuteOptions) {
    this.sqlitePath = join(o.dir, 'telegram.sqlite');
    const sql = new SqliteStorage(this.sqlitePath);
    // The auth keys stay out of the database: the session string in secret.json is where they live.
    const storage = { driver: sql.driver, kv: sql.kv, peers: sql.peers, refMessages: sql.refMessages, authKeys: new MemoryAuthKeysRepository(new MemoryStorageDriver()) };
    this.client = new TelegramClient({
      apiId: o.apiId,
      apiHash: o.apiHash,
      storage,
      testMode: o.testMode,
      initConnectionOptions: o.initConnection ?? { deviceModel: o.deviceModel, appVersion: o.appVersion, systemVersion: 'Linux', langCode: 'en', systemLangCode: 'en' },
      updates: { catchUp: true },
      logLevel: o.logLevel ?? 2,
    });
    const LEVEL: Record<number, 'error' | 'warn' | 'info' | 'debug'> = { 1: 'error', 2: 'warn', 3: 'info', 4: 'debug', 5: 'debug' };
    this.client.log.mgr.handler = (_color, level, tag, fmt, args) => o.log(LEVEL[level] ?? 'debug', `mtcute ${tag}: ${format(fmt, args)}`);
    this.client.onRawUpdate.add((info) => {
      const u: UpdateInfo = { update: info.update, users: [...info.peers.users.values()], chats: [...info.peers.chats.values()] };
      if (this.onUpdate) this.onUpdate(u);
      else if (this.queue.length < 10_000) this.queue.push(u);
    });
    this.client.onError.add((e) => o.log('warn', `mtcute: ${e.message}`));
  }

  async start(session: string | null): Promise<tl.RawUser | null> {
    if (session) await this.client.importSession(session, true);
    await this.client.connect();
    this.dc = await this.client.getPrimaryDcId().catch(() => null);
    if (!session) return null;
    const [self] = await this.client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] });
    if (self?._ !== 'user') return null;
    await this.client.notifyLoggedIn(self);
    return self;
  }

  async qrLogin(h: QrHandlers): Promise<tl.RawUser> {
    let wrong = false;
    let hint: string | null = null;
    const user = await this.client.signInQr({
      onUrlUpdated: (url, expires) => h.onUrl(url, expires.getTime()),
      onQrScanned: () => h.onScanned(),
      password: async () => {
        hint ??= await this.passwordHint().catch(() => null);
        const p = await h.password(hint, wrong);
        wrong = true;
        return p;
      },
      invalidPasswordCallback: () => {},
      abortSignal: h.signal,
    });
    this.dc = await this.client.getPrimaryDcId().catch(() => this.dc);
    return user.raw;
  }

  async sendCode(phone: string): Promise<SentCode> {
    const r = await this.client.sendCode({ phone });
    if (!('phoneCodeHash' in r)) throw new Error('Telegram signed in without a code');
    this.dc = await this.client.getPrimaryDcId().catch(() => this.dc);
    return sent(r);
  }

  async resendCode(phone: string, phoneCodeHash: string): Promise<SentCode> {
    return sent(await this.client.resendCode({ phone, phoneCodeHash }));
  }

  async signIn(phone: string, phoneCodeHash: string, code: string): Promise<tl.RawUser> {
    return (await this.client.signIn({ phone, phoneCodeHash, phoneCode: code })).raw;
  }

  async checkPassword(password: string): Promise<tl.RawUser> {
    return (await this.client.checkPassword(password)).raw;
  }

  async passwordHint(): Promise<string | null> {
    const p = await this.client.call({ _: 'account.getPassword' });
    return p.hint ?? null;
  }

  exportSession(): Promise<string> {
    return this.client.exportSession();
  }

  async call<T extends tl.RpcMethod>(req: T, opts: { timeoutMs?: number; floodSleepMs?: number; once?: boolean } = {}): Promise<tl.RpcCallReturn[T['_']]> {
    // A call that acts is sent once: no sleeping through a flood wait and retrying, no retry after an internal error.
    const once = opts.once ? { floodSleepThreshold: 0, maxRetryCount: 0, throw503: true } : { floodSleepThreshold: opts.floodSleepMs ?? 10_000 };
    const res = await this.client.call(req as never, { ...once, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
    // Keep mtcute's sequence numbers right; the adapter maps what came back itself.
    const kind = res && typeof res === 'object' ? (res as { _: string })._ : '';
    const inside = updatesIn(res);
    if (inside) this.client.handleClientUpdate(inside, true);
    else if (kind === 'updateShortSentMessage') {
      // mtcute's own sendText does this: the pts the send used, so no gap and no catching up after it.
      const r = res as tl.RawUpdateShortSentMessage;
      this.client.handleClientUpdate({ _: 'updates', seq: 0, date: 0, chats: [], users: [], updates: [{ _: 'mtcute.dummyUpdate', channelId: 0, pts: r.pts, ptsCount: r.ptsCount } as never] }, true);
    } else if (kind === 'messages.affectedMessages' || kind === 'messages.affectedHistory') {
      // As mtcute's own deleteMessages and readHistory do (its createDummyUpdate): the pts this call used up.
      const a = res as tl.messages.RawAffectedMessages;
      const channel = (req as { channel?: { _: string; channelId?: number } }).channel;
      const channelId = channel?._ === 'inputChannel' ? Number(channel.channelId) : 0;
      this.client.handleClientUpdate({ _: 'updates', seq: 0, date: 0, chats: [], users: [], updates: [{ _: 'mtcute.dummyUpdate', channelId, pts: a.pts, ptsCount: a.ptsCount } as never] }, true);
    }
    return res as tl.RpcCallReturn[T['_']];
  }

  async startUpdates(onUpdate: (u: UpdateInfo) => void, onState: (s: ConnState) => void): Promise<void> {
    this.onUpdate = onUpdate;
    for (const u of this.queue.splice(0)) onUpdate(u);
    this.client.onConnectionState.add((s) => onState(s));
  }

  async uploadFile(f: UploadSpec): Promise<tl.TypeInputFile> {
    const up = await this.client.uploadFile({ file: Bun.file(f.path).stream(), fileName: f.name, fileSize: f.size, fileMime: f.mime });
    return up.inputFile;
  }

  download(location: tl.TypeInputFileLocation, opts: { dcId?: number; size?: number }): Promise<Uint8Array> {
    return this.client.downloadAsBuffer(location, { ...(opts.dcId ? { dcId: opts.dcId } : {}), ...(opts.size ? { fileSize: opts.size } : {}) });
  }

  async logOut(): Promise<void> {
    await this.client.logOut();
  }

  async wipe(): Promise<void> {
    await this.client.notifyLoggedOut().catch(() => {});
    await this.client.destroy().catch(() => {});
    for (const p of [this.sqlitePath, `${this.sqlitePath}-wal`, `${this.sqlitePath}-shm`]) if (existsSync(p)) rmSync(p, { force: true });
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }

  /** Fetch what was missed (updates.getDifference): when the key is shared, Telegram may send some updates elsewhere. */
  catchUp() {
    const updates = (this.client as unknown as { updates?: { catchUp(): void } }).updates;
    updates?.catchUp();
  }

  info(): BackendInfo {
    return { library: 'mtcute 0.32', layer: 232, testMode: this.o.testMode, dc: this.dc };
  }
}

function sent(r: { phoneCodeHash: string; type: string; nextType: string; timeout: number; length: number }): SentCode {
  return { phoneCodeHash: r.phoneCodeHash, type: r.type, ...(r.length ? { length: r.length } : {}), ...(r.nextType && r.nextType !== 'none' ? { nextType: r.nextType } : {}), ...(r.timeout ? { timeout: r.timeout } : {}) };
}

/** mtcute's printf-style log lines. */
function format(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[sdjeh]/g, (m) => {
    const a = args[i++];
    if (m === '%j') {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    if (m === '%e') return a instanceof Error ? a.message : String(a);
    return String(a);
  });
}

// ---------------------------------------------------------------- Telegram Desktop's key

/** Production DCs' first addresses (mtcute moves to the DC list from Telegram's config once connected). */
const DCS: Record<number, string> = { 1: '149.154.175.50', 2: '149.154.167.51', 3: '149.154.175.100', 4: '149.154.167.91', 5: '149.154.171.5' };
const TEST_DCS: Record<number, string> = { 1: '149.154.175.10', 2: '149.154.167.40', 3: '149.154.175.117' };

function keySession(key: DesktopKey, testMode: boolean) {
  const ip = (testMode ? TEST_DCS : DCS)[key.dcId];
  if (!ip) throw new Error(`Telegram Desktop's session is on DC ${key.dcId}, which is not a known ${testMode ? 'test ' : ''}DC`);
  const dc = { id: key.dcId, ipAddress: ip, port: 443, ...(testMode ? { testMode: true } : {}) };
  return { primaryDcs: { main: dc, media: dc }, authKey: key.authKey, self: { userId: Number(key.userId), isBot: false, isPremium: false, usernames: [] } };
}

/**
 * What Telegram Desktop 7.2.9 sends in initConnection from inside our sandbox (no /sys, no window manager, X11),
 * so a client on its key looks like it in Settings → Devices: the device model falls back to "Desktop", the system
 * is "Linux X11 glibc <its glibc>", the version "7.2.9", the language pack "tdesktop".
 */
export function desktopProfile(bin?: string | null): InitConnection {
  let glibc: string | null = null;
  let version = '7.2.9';
  try {
    const head = bin ? readFileSync(bin).subarray(0, 4096).toString('latin1') : '';
    glibc = head.match(/glibc-(\d+\.\d+)/)?.[1] ?? null;
    version = bin?.match(/telegram-desktop-(\d+\.\d+\.\d+)/)?.[1] ?? version;
  } catch {}
  const tz = -new Date().getTimezoneOffset() * 60;
  return {
    deviceModel: 'Desktop',
    systemVersion: ['Linux', 'X11', ...(glibc ? ['glibc', glibc] : [])].join(' '),
    appVersion: version,
    systemLangCode: 'en-US',
    langPack: 'tdesktop',
    langCode: 'en',
    params: { _: 'jsonObject', value: [{ _: 'jsonObjectValue', key: 'tz_offset', value: { _: 'jsonNumber', value: Math.round(tz / 900) * 900 } }] },
  };
}

/** A session string for Telegram Desktop's key (the shared fallback). Nothing connects. */
export async function sessionFromKey(key: DesktopKey, testMode: boolean): Promise<string> {
  const c = new TelegramClient({ apiId: 1, apiHash: '0'.repeat(32), storage: new MemoryStorage(), testMode, logLevel: 0 });
  try {
    await c.importSession(keySession(key, testMode), true);
    return await c.exportSession();
  } finally {
    await c.destroy().catch(() => {});
  }
}

/**
 * A short-lived client on Telegram Desktop's key, as Telegram Desktop (its api_id and initConnection), that makes one
 * call: auth.acceptLoginToken, which signs in the extractor's own new session. No updates, nothing stored, and never
 * a sign-out: closing it only drops the connection.
 */
export class MtcuteDeskClient implements DeskClient {
  private client: TelegramClient;
  constructor(
    private key: DesktopKey,
    private o: { apiId: number; apiHash: string; testMode: boolean; profile: InitConnection; log: Log; logLevel?: number },
  ) {
    this.client = new TelegramClient({ apiId: o.apiId, apiHash: o.apiHash, storage: new MemoryStorage(), testMode: o.testMode, disableUpdates: true, initConnectionOptions: o.profile, logLevel: o.logLevel ?? 1 });
    this.client.onError.add((e) => o.log('warn', `desktop key client: ${e.message}`));
  }

  async acceptLoginToken(token: Uint8Array): Promise<void> {
    await this.client.importSession(keySession(this.key, this.o.testMode), true);
    await this.client.connect();
    await this.client.call({ _: 'auth.acceptLoginToken', token });
  }

  async close(): Promise<void> {
    await this.client.destroy().catch(() => {});
  }
}
