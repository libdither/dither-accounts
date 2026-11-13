/**
 * End-to-end encryption: one OlmMachine from matrix-sdk-crypto-wasm (the Rust crypto Element uses),
 * and the Client-Server requests it asks for. No Olm or Megolm is implemented here.
 *
 * Loaded only for accounts that set encryption up: the module is 8 MB of WebAssembly, and
 * creating the machine is what generates a device's keys.
 *
 * Never logged: request bodies, keys, the store key, the recovery key, decrypted content.
 */

import * as M from '@matrix-org/matrix-sdk-crypto-wasm';
import { join } from 'node:path';
import { CryptoStore } from './cryptostore.ts';
import { enc, MatrixError, type MatrixClient } from './http.ts';
import { checkSecretKey, decodeRecoveryKey, decryptSecret, keyFromPassphrase, recoveryKeyProblem, type SecretKeyInfo, type SecretPayload } from './recovery.ts';
import { Backoff, Outbox } from './retry.ts';
import type { MxEvent } from './rooms.ts';

export const MEGOLM = 'm.megolm.v1.aes-sha2';
const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const BACKUP_SECRET = 'm.megolm_backup.v1';
/** How long a session the backup did not have is left alone. Another client may upload it later. */
const BACKUP_RETRY_MS = 60 * 60 * 1000;
const BACKUP_WORKERS = 4;
/**
 * The library's limits on a verification (matrix-sdk-crypto, verification/requests.rs and sas/sas_state.rs):
 * a request lives 10 minutes; the emoji step 5 minutes in all, and is cancelled if nothing comes from
 * the other device for 60 s. That check runs at the start of each sync, before the sync's own messages
 * are read, so a late sync can end a flow whose next message is already waiting on the server.
 */
const SAS_MAX_AGE_MS = 5 * 60_000;
const SAS_EVENT_TIMEOUT_MS = 60_000;
/** A message of a flow that is over is still retried this long when it is the cancel, so the other side stops too. */
const CANCEL_RETRY_FOR_MS = 2 * 60_000;
/** Any other verification message is given up after this; no flow outlives it. */
const VERIFICATION_RETRY_FOR_MS = 10 * 60_000;
/** A flow that ended without verifying stays on screen this long, or until dismissed. */
const ENDED_SHOWN_MS = 30 * 60_000;

export interface E2eeOptions {
  dir: string;
  userId: string;
  deviceId: string;
  /** 32 random bytes, base64, kept in secret.json. The library encrypts the store's values with it. */
  storeKey: string;
  /** Asked each time: a relogin replaces the client. */
  client: () => MatrixClient;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Delays between retries of failed crypto requests (tests make them short). */
  retryMs?: number[];
  /** Keys for these sessions just arrived (a to-device message, the backup, another device). */
  onRoomKeys: (keys: { roomId: string; sessionId: string }[]) => void;
  onVerification: (v: VerificationState | null) => void;
}

export interface VerificationState {
  flowId: string;
  /**
   * requested: they asked, waiting for you to accept. waiting: for the other device. ready: both said yes,
   * waiting for them to start the emoji step (or for you to). compare: emoji on screen. confirmed: you said
   * they match, waiting for the other device. ended: it stopped without verifying; `reason` says why.
   */
  phase: 'requested' | 'waiting' | 'ready' | 'compare' | 'confirmed' | 'ended';
  otherDevice: string | null;
  /** The name the other device gave itself, if its keys are known. */
  otherDeviceName?: string | null;
  weStarted?: boolean;
  /** When the library gives up on the current step unless the other device answers first (ms since the epoch). */
  expiresAt?: number;
  emoji?: { symbol: string; description: string }[];
  decimals?: number[];
  /** Messages of ours that wait for the homeserver connection, and are being retried. */
  sending?: number;
  /** ended: timeout, cancelled (by the other device), mismatch (you said they differ), replaced, or error. */
  outcome?: 'timeout' | 'cancelled' | 'mismatch' | 'error';
  reason?: string;
  cancelledBy?: 'us' | 'them';
  endedAt?: number;
}


export interface Decrypted {
  type: string;
  content: any;
}

export interface RoomEncryption {
  /** m.room.encryption content */
  settings: { algorithm?: unknown; rotation_period_ms?: unknown; rotation_period_msgs?: unknown };
  historyVisibility?: string;
}

const HISTORY: Record<string, M.HistoryVisibility> = {
  invited: M.HistoryVisibility.Invited,
  joined: M.HistoryVisibility.Joined,
  shared: M.HistoryVisibility.Shared,
  world_readable: M.HistoryVisibility.WorldReadable,
};

/** Media types the hub may serve as what they claim. Anything else from a sender (HTML, SVG, ...) stays a download. */
export function safeMediaType(mime: unknown): string {
  if (typeof mime !== 'string') return 'application/octet-stream';
  const m = mime.split(';')[0].trim().toLowerCase();
  if (/^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|text\/plain|application\/pdf)$/.test(m)) return m;
  return 'application/octet-stream';
}

export function encryptAttachment(bytes: Uint8Array): { data: Uint8Array; file: Record<string, unknown> } {
  const a = M.Attachment.encrypt(bytes);
  // In this order: reading the info consumes it, and it is what the data's hash lives in.
  const data = a.encryptedData;
  const info = a.mediaEncryptionInfo;
  if (!info) throw new Error('the library returned no attachment key');
  return { data, file: JSON.parse(info) };
}

/** Checks the ciphertext's hash, so a server that swaps the file gets an error rather than garbage. */
export function decryptAttachment(data: Uint8Array, file: Record<string, unknown>): Uint8Array {
  const { url: _url, ...info } = file;
  return M.Attachment.decrypt(new M.EncryptedAttachment(data, JSON.stringify(info)));
}

export class E2ee {
  readonly identity: { ed25519: string; curve25519: string };
  readonly deviceId: string;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private roomQueues = new Map<string, Promise<unknown>>();
  private tracked = new Set<string>();
  private backup: { version: string; key: M.BackupDecryptionKey; publicKey: string } | null = null;
  private backupTried = new Map<string, number>();
  private backupQueue: { roomId: string; sessionId: string }[] = [];
  private backupWorkers = 0;
  private flow: { id: string; sasSince: number | null } | null = null;
  private verification: VerificationState | null = null;
  private verificationResult: string | null = null;
  /** The last flow that ended without verifying, shown until dismissed. */
  private ended: VerificationState | null = null;
  /** Flows we cancelled because a newer request replaced them: not worth an "ended" notice. */
  private replaced = new Set<string>();
  /** When the last m.key.verification.* message of each flow arrived: the library's 60 s clock. */
  private lastIncoming = new Map<string, number>();
  private verifyLock: Promise<unknown> = Promise.resolve();
  private outbox: Outbox<any>;
  private flushBackoff: Backoff;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastFlushError: string | null = null;

  private constructor(
    private readonly opts: E2eeOptions,
    private readonly machine: M.OlmMachine,
    private readonly store: CryptoStore,
  ) {
    this.deviceId = opts.deviceId;
    this.flushBackoff = new Backoff(opts.retryMs);
    this.outbox = new Outbox<any>({
      send: (req) => this.sendRequest(req, { retries: 0, timeoutMs: 15_000 }),
      wanted: (item) => this.stillWanted(item),
      backoff: new Backoff(opts.retryMs),
      onChange: () => this.publish(),
      log: (level, msg) => this.opts.log(level, `verification: ${msg}`),
    });
    const k = machine.identityKeys;
    this.identity = { ed25519: k.ed25519.toBase64(), curve25519: k.curve25519.toBase64() };
  }

  /**
   * Open the store, creating the device's keys if it is empty. Nothing leaves this
   * machine until the first flush().
   */
  static async open(opts: E2eeOptions): Promise<E2ee> {
    await M.initAsync();
    const store = await CryptoStore.open(join(opts.dir, 'crypto.sqlite'));
    try {
      const key = new Uint8Array(Buffer.from(opts.storeKey, 'base64'));
      if (key.length !== 32) throw new Error('the store key in secret.json is not 32 bytes');
      const handle = await M.StoreHandle.openWithKey(`dither:${opts.deviceId}`, key);
      const machine = await M.OlmMachine.initFromStore(new M.UserId(opts.userId), new M.DeviceId(opts.deviceId), handle);
      const self = new E2ee(opts, machine, store);
      await machine.registerRoomKeyUpdatedCallback(async (infos) => {
        opts.onRoomKeys(infos.map((i) => ({ roomId: i.roomId.toString(), sessionId: i.sessionId })));
      });
      await machine.registerReceiveSecretCallback(async (name, value) => {
        if (name === BACKUP_SECRET) await self.acceptBackupSecret(value).catch((e) => opts.log('warn', `could not use the backup key another device sent: ${e.message}`));
      });
      await self.track([opts.userId]);
      const saved = await machine.getBackupKeys();
      if (saved.decryptionKey && saved.backupVersion) self.backup = { version: saved.backupVersion, key: saved.decryptionKey, publicKey: saved.decryptionKey.megolmV1PublicKey.publicKeyBase64 };
      return self;
    } catch (e) {
      store.close();
      throw e;
    }
  }

  close() {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.outbox.stop();
    this.machine.close();
    this.store.close();
  }

  // ---------------------------------------------------------------- requests the machine wants made

  private async sendRequest(req: any, opts: { retries?: number; timeoutMs?: number } = {}) {
    const c = this.opts.client();
    const json = { contentType: 'application/json', body: req.body, ...opts };
    let res: unknown;
    switch (req.type) {
      case M.RequestType.KeysUpload:
        res = await c.request('POST', '/_matrix/client/v3/keys/upload', json);
        break;
      case M.RequestType.KeysQuery:
        res = await c.request('POST', '/_matrix/client/v3/keys/query', json);
        break;
      case M.RequestType.KeysClaim:
        res = await c.request('POST', '/_matrix/client/v3/keys/claim', json);
        break;
      case M.RequestType.ToDevice:
        res = await c.request('PUT', `/_matrix/client/v3/sendToDevice/${enc(req.event_type)}/${enc(req.txn_id)}`, json);
        break;
      case M.RequestType.SignatureUpload:
        res = await c.request('POST', '/_matrix/client/v3/keys/signatures/upload', json);
        break;
      case M.RequestType.RoomMessage:
        res = await c.request('PUT', `/_matrix/client/v3/rooms/${enc(req.room_id)}/send/${enc(req.event_type)}/${enc(req.txn_id)}`, json);
        break;
      case M.RequestType.KeysBackup:
        res = await c.request('PUT', '/_matrix/client/v3/room_keys/keys', { ...json, query: { version: req.version } });
        break;
      default:
        throw new Error(`unknown crypto request type ${req.type}`);
    }
    if (req.id) await this.machine.markRequestAsSent(req.id, req.type, JSON.stringify(res));
  }

  /**
   * Make every request the machine has queued. One flush at a time; a call during one runs another round after it.
   * What fails stays queued in the machine, and another flush is scheduled with backoff, so a dropped
   * connection does not leave a key upload or a verification message waiting for the next sync.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      let firstError: unknown = null;
      do {
        this.flushAgain = false;
        const reqs = await this.machine.outgoingRequests();
        const results = await Promise.allSettled(reqs.map((r) => this.sendRequest(r, { retries: 1 })));
        for (const r of results) if (r.status === 'rejected') firstError ??= r.reason;
        await this.uploadToBackup().catch((e: unknown) => (firstError ??= e));
      } while (this.flushAgain && !this.stopped);
      this.lastFlushError = firstError ? String((firstError as Error).message ?? firstError) : null;
      if (firstError) {
        this.scheduleFlush(this.lastFlushError!);
        throw firstError;
      }
      if (this.flushBackoff.failures) this.opts.log('info', `crypto requests went through after ${this.flushBackoff.failures} failed ${this.flushBackoff.failures === 1 ? 'try' : 'tries'}`);
      this.flushBackoff.reset();
    })().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private scheduleFlush(error: string) {
    const delay = this.flushBackoff.fail();
    if (this.flushBackoff.failures === 1) this.opts.log('warn', `crypto requests failed (${error}); retrying with backoff`);
    else this.opts.log('debug', `crypto requests failed again (${error}); next try in ${delay / 1000}s`);
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.stopped) this.flush().catch(() => {});
    }, delay);
  }

  /** The homeserver answered something just now: whatever waits for a retry can go at once. */
  private connectionWorks() {
    this.outbox.wake();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flush().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- verification messages

  /**
   * Deliver verification messages the library returns rather than queues (start, accept, ready, the MAC,
   * cancel). Sent once, they were lost on a network error, and the other device waited until it timed out.
   * In order, one at a time, each retried with backoff until it goes out or its flow is over. A to-device
   * send has a transaction id, so a retry of one that did arrive is not delivered twice.
   */
  private deliver(req: any, flowId: string, cancel = false): Promise<boolean> {
    return req ? this.outbox.push(req, flowId, cancel) : Promise.resolve(true);
  }

  private stillWanted({ key: flowId, cancel, age }: { key: string; cancel: boolean; age: number }): boolean {
    if (this.stopped) return false;
    if (cancel) return age < CANCEL_RETRY_FOR_MS;
    if (age >= VERIFICATION_RETRY_FOR_MS) return false;
    const req = this.machine.getVerificationRequest(new M.UserId(this.opts.userId), flowId);
    // Done still delivers: the last MAC or done message is what lets the other side finish.
    return !req?.isCancelled();
  }

  private pendingFor(flowId: string): number {
    return this.outbox.pending(flowId);
  }

  /** Room keys this device holds that the backup does not, so another client can read what only we received. */
  private async uploadToBackup() {
    if (!this.backup || !(await this.machine.isBackupEnabled())) return;
    for (;;) {
      const req = await this.machine.backupRoomKeys();
      if (!req) return;
      try {
        await this.sendRequest(req);
      } catch (e) {
        if (e instanceof MatrixError && (e.errcode === 'M_WRONG_ROOM_KEYS_VERSION' || e.errcode === 'M_NOT_FOUND')) {
          this.opts.log('warn', 'the room key backup changed on the server; no longer uploading to it');
          await this.machine.disableBackup();
          return;
        }
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------- /sync

  /** The crypto half of a sync response. Runs before its timelines, so keys in this batch decrypt the events in it. */
  async receiveSync(res: any) {
    const toDevice = Array.isArray(res.to_device?.events) ? res.to_device.events : [];
    const changed = (res.device_lists?.changed ?? []).flatMap(toUserId);
    const left = (res.device_lists?.left ?? []).flatMap(toUserId);
    const counts = new Map<string, number>(Object.entries(res.device_one_time_keys_count ?? {}));
    const fallback = Array.isArray(res.device_unused_fallback_key_types) ? new Set<string>(res.device_unused_fallback_key_types) : undefined;
    this.connectionWorks();
    await this.locked(() => this.beforeVerificationMessages(toDevice));
    await this.machine.receiveSyncChanges(JSON.stringify(toDevice), new M.DeviceLists(changed, left), counts, fallback, new M.DecryptionSettings(M.TrustRequirement.Untrusted));
    await this.flush().catch(() => {}); // logged and retried by flush itself
    await this.tickVerification().catch((e) => this.opts.log('warn', `verification: ${e.message}`));
  }

  /**
   * Verification messages in this batch, before the library reads them. Notes when each flow last heard
   * from the other device, and makes way for a newer request: the library cancels both the old and the
   * new one when a second request arrives while one is open, so the old one is cancelled here first.
   */
  private async beforeVerificationMessages(toDevice: any[]) {
    const user = new M.UserId(this.opts.userId);
    const now = Date.now();
    for (const ev of toDevice) {
      if (typeof ev?.type !== 'string' || !ev.type.startsWith('m.key.verification.') || ev.sender !== this.opts.userId) continue;
      const flowId = ev.content?.transaction_id;
      if (typeof flowId !== 'string') continue;
      this.lastIncoming.set(flowId, now);
      if (ev.type !== 'm.key.verification.request' || this.machine.getVerificationRequest(user, flowId)) continue;
      for (const old of this.machine.getVerificationRequests(user)) {
        if (old.flowId === flowId || old.isDone() || old.isCancelled()) continue;
        this.opts.log('info', `verification: device ${ev.content?.from_device ?? '?'} asked again; cancelling the older request so the new one can go ahead`);
        await this.cancelFlow(old, true);
      }
    }
  }

  /** Cancel a flow, and deliver the cancel. `replaced`: a newer one takes over, so this is no news for the user. */
  private async cancelFlow(req: M.VerificationRequest, replaced: boolean, code?: string) {
    if (replaced) this.replaced.add(req.flowId);
    const sas = req.getVerification();
    const out = sas instanceof M.Sas ? (code ? sas.cancelWithCode(code) : sas.cancel()) : req.cancel();
    await this.deliver(out, req.flowId, true);
  }

  private async track(users: string[]) {
    const fresh = users.filter((u) => !this.tracked.has(u));
    if (!fresh.length) return;
    for (const u of fresh) this.tracked.add(u);
    await this.machine.updateTrackedUsers(fresh.flatMap(toUserId));
  }

  // ---------------------------------------------------------------- decrypt

  /** null: no key for it (yet). The caller keeps it for a retry. */
  async decrypt(ev: MxEvent, roomId: string): Promise<Decrypted | null> {
    try {
      const d = await this.machine.decryptRoomEvent(JSON.stringify(ev), new M.RoomId(roomId), new M.DecryptionSettings(M.TrustRequirement.Untrusted));
      const clear = JSON.parse(d.event);
      const content = clear.content ?? {};
      // Relations travel outside the ciphertext, and the library may leave them there.
      if (!content['m.relates_to'] && ev.content?.['m.relates_to']) content['m.relates_to'] = ev.content['m.relates_to'];
      return { type: clear.type, content };
    } catch (e: any) {
      if (e instanceof M.MegolmDecryptionError) this.opts.log('debug', `no key for ${ev.event_id}: ${M.DecryptionErrorCode[e.code]}${e.withheldCode ? ` (withheld: ${e.withheldCode})` : ''}`);
      else this.opts.log('warn', `could not decrypt ${ev.event_id}: ${e?.message ?? e}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- encrypt

  /** One thing at a time per room: a second send must not race the first one's key share. */
  private inRoom<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.roomQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.roomQueues.set(roomId, tail);
    void tail.then(() => {
      if (this.roomQueues.get(roomId) === tail) this.roomQueues.delete(roomId);
    });
    return next;
  }

  /**
   * The content of an m.room.encrypted event, with the room key shared with every device
   * of `members` first. Throws if any step fails. The caller must then not send at all.
   */
  encrypt(roomId: string, members: string[], room: RoomEncryption, type: string, content: unknown): Promise<any> {
    if (room.settings.algorithm !== MEGOLM) throw new Error(`this room uses an encryption algorithm we do not support (${String(room.settings.algorithm)})`);
    return this.inRoom(roomId, async () => {
      await this.track(members);
      await this.flush(); // the device lists of anyone just tracked; sharing without them would skip their devices
      const claim = await this.machine.getMissingSessions(members.flatMap(toUserId));
      if (claim) await this.sendRequest(claim);
      const settings = new M.EncryptionSettings();
      settings.algorithm = M.EncryptionAlgorithm.MegolmV1AesSha2;
      settings.sharingStrategy = M.CollectStrategy.allDevices();
      settings.historyVisibility = HISTORY[room.historyVisibility ?? ''] ?? M.HistoryVisibility.Shared;
      if (Number.isSafeInteger(room.settings.rotation_period_ms)) settings.rotationPeriod = BigInt(room.settings.rotation_period_ms as number) * 1000n;
      if (Number.isSafeInteger(room.settings.rotation_period_msgs)) settings.rotationPeriodMessages = BigInt(room.settings.rotation_period_msgs as number);
      const rid = new M.RoomId(roomId);
      for (const req of await this.machine.shareRoomKey(rid, members.flatMap(toUserId), settings)) await this.sendRequest(req);
      return JSON.parse(await this.machine.encryptRoomEvent(rid, type, JSON.stringify(content)));
    });
  }

  encryptAttachment = encryptAttachment;
  decryptAttachment = decryptAttachment;
  safeMediaType = safeMediaType;

  // ---------------------------------------------------------------- recovery key and backup

  private accountData<T = any>(type: string): Promise<T | null> {
    const c = this.opts.client();
    return c.request<T>('GET', `/_matrix/client/v3/user/${enc(this.opts.userId)}/account_data/${enc(type)}`, { retries: 1 }).catch((e) => {
      if (e instanceof MatrixError && (e.status === 404 || e.errcode === 'M_NOT_FOUND')) return null;
      throw e;
    });
  }

  private async backupInfo(): Promise<{ version: string; publicKey: string } | null> {
    try {
      const info: any = await this.opts.client().request('GET', '/_matrix/client/v3/room_keys/version', { retries: 1 });
      if (info?.algorithm !== BACKUP_ALGORITHM || typeof info?.auth_data?.public_key !== 'string' || typeof info.version !== 'string') return null;
      return { version: info.version, publicKey: info.auth_data.public_key.replace(/=+$/, '') };
    } catch (e) {
      if (e instanceof MatrixError && (e.status === 404 || e.errcode === 'M_NOT_FOUND')) return null;
      throw e;
    }
  }

  private async useBackupKey(base64: string, known?: { version: string; publicKey: string } | null): Promise<boolean> {
    const info = known ?? (await this.backupInfo());
    if (!info) return false;
    const key = M.BackupDecryptionKey.fromBase64(base64);
    const publicKey = key.megolmV1PublicKey.publicKeyBase64.replace(/=+$/, '');
    if (publicKey !== info.publicKey) return false;
    await this.machine.saveBackupDecryptionKey(key, info.version);
    await this.machine.enableBackupV1(publicKey, info.version);
    this.backup = { version: info.version, key, publicKey };
    this.backupTried.clear();
    return true;
  }

  private async acceptBackupSecret(value: string) {
    if (this.backup) return;
    if (await this.useBackupKey(value)) {
      this.opts.log('info', 'received the room key backup key from a verified device');
      await this.machine.deleteSecretsFromInbox(BACKUP_SECRET);
    }
  }

  /** Is the saved backup still the one on the server, and may we write to it? Run at startup. */
  async resumeBackup() {
    if (!this.backup) return;
    const info = await this.backupInfo();
    if (!info || info.publicKey !== this.backup.publicKey.replace(/=+$/, '')) {
      this.opts.log('warn', 'the room key backup on the server is not the one the saved key opens; ignoring it');
      await this.machine.disableBackup();
      this.backup = null;
      return;
    }
    if (info.version !== this.backup.version) await this.machine.saveBackupDecryptionKey(this.backup.key, info.version);
    this.backup.version = info.version;
    await this.machine.enableBackupV1(this.backup.publicKey, info.version);
  }

  /**
   * Whatever the user pasted: a backup key, a Secret Storage key, or a Secret Storage passphrase.
   * With Secret Storage this also imports the cross-signing keys and signs this device with them,
   * which is what verifying with a recovery key means. Throws, saying what was wrong, if the input
   * opens nothing; `problems` lists what it could not do when it opened something.
   */
  async applyRecoveryKey(input: string): Promise<{ backup: boolean; crossSigned: boolean; problems: string[] }> {
    const user = new M.UserId(this.opts.userId);
    const defaultKey = await this.accountData<{ key?: string }>('m.secret_storage.default_key');
    const keyId = typeof defaultKey?.key === 'string' ? defaultKey.key : null;
    const keyInfo = keyId ? await this.accountData<SecretKeyInfo>(`m.secret_storage.key.${keyId}`) : null;
    const typed = input.trim();
    let key = decodeRecoveryKey(typed);
    const looksLikeKey = recoveryKeyProblem(typed);
    if (!key && looksLikeKey) throw new Error(looksLikeKey);
    const asPassphrase = !key;
    if (!key && keyInfo) {
      key = await keyFromPassphrase(typed, keyInfo);
      if (!key) throw new Error("that is not a recovery key, and this account's secret storage has no security phrase to try it as. Paste the recovery key itself (48 letters and digits, starting with \"Es\")");
    }
    if (!key) {
      throw new Error(keyId ? 'that is not a recovery key (48 letters and digits, starting with "Es")' : 'that is not a recovery key, and this account has no secret storage that a security phrase could open');
    }

    if (keyInfo && (await checkSecretKey(key, keyInfo))) return this.openSecretStorage(key, keyId!, user);
    // An old-style key: the key of the room key backup itself.
    const backupInfo = await this.backupInfo();
    if (backupInfo && (await this.useBackupKey(Buffer.from(key).toString('base64').replace(/=+$/, ''), backupInfo))) {
      return { backup: true, crossSigned: false, problems: ['it is the key of the room key backup only, so it cannot verify this device; verify with another device for that'] };
    }
    if (keyInfo) {
      throw new Error(
        asPassphrase
          ? "that security phrase does not unlock this account's secret storage"
          : "that key does not unlock this account's secret storage. If the recovery key was reset in another client, only the newest one works",
      );
    }
    if (!keyId) {
      throw new Error(
        backupInfo
          ? 'that key does not open the room key backup, and this account has no secret storage. Verify with another device instead'
          : 'this account has no secret storage and no room key backup, so there is nothing a recovery key could unlock. Verify with another device instead, or set up recovery in Element first',
      );
    }
    throw new Error(`this account names secret storage key ${keyId}, but its description is missing from the account; set up recovery again in Element`);
  }

  private async openSecretStorage(key: Uint8Array, keyId: string, user: M.UserId): Promise<{ backup: boolean; crossSigned: boolean; problems: string[] }> {
    const problems: string[] = [];
    const secret = async (name: string): Promise<string | null> => {
      const payload = (await this.accountData<{ encrypted?: Record<string, SecretPayload> }>(name))?.encrypted?.[keyId];
      return payload ? decryptSecret(key, name, payload) : null;
    };

    let backup = false;
    const backupInfo = await this.backupInfo();
    const backupSecret = await secret(BACKUP_SECRET);
    if (!backupInfo) problems.push('this account has no room key backup on the server, so old messages cannot be restored from one');
    else if (!backupSecret) problems.push('secret storage does not hold the key of the room key backup');
    else if (!(backup = await this.useBackupKey(backupSecret.trim(), backupInfo))) problems.push(`the backup key in secret storage is for an older backup, not the current one (version ${backupInfo.version})`);

    let crossSigned = false;
    const [master, selfSigning, userSigning] = await Promise.all([secret('m.cross_signing.master'), secret('m.cross_signing.self_signing'), secret('m.cross_signing.user_signing')]);
    if (!selfSigning) problems.push('secret storage does not hold the cross-signing keys, so this device cannot sign itself');
    else {
      // Our own published identity, fresh: the keys from secret storage are checked against it.
      await this.sendWithRetry(this.machine.queryKeysForUsers([new M.UserId(this.opts.userId)]), "asking the homeserver for this account's keys");
      if (!(await this.machine.getIdentity(user))) problems.push('the homeserver has no cross-signing identity for this account');
      else {
        const status = await this.machine.importCrossSigningKeys(master, selfSigning, userSigning).catch((e: Error) => {
          this.opts.log('warn', `the cross-signing keys from secret storage were not accepted: ${e.message}`);
          return null;
        });
        if (!status?.hasSelfSigning) problems.push("the cross-signing keys in secret storage do not match this account's identity (it was probably reset since); set up recovery again in Element");
        else crossSigned = await this.signOurDevice();
      }
    }
    if (crossSigned) {
      this.ended = null;
      this.publish();
    }
    return { backup, crossSigned, problems };
  }

  private async signOurDevice(): Promise<boolean> {
    const status = await this.machine.crossSigningStatus();
    if (!status.hasSelfSigning) return false;
    const user = new M.UserId(this.opts.userId);
    const device = await this.machine.getDevice(user, new M.DeviceId(this.opts.deviceId));
    if (!device) return false;
    await this.sendWithRetry(await device.verify(), 'uploading the signature of this device');
    // See our own device as the server now has it, signature included.
    // (queryKeysForUsers takes ownership of the ids it is given, hence a new one.)
    await this.sendWithRetry(this.machine.queryKeysForUsers([new M.UserId(this.opts.userId)]), "asking the homeserver for this account's keys");
    return true;
  }

  /** For a step the user waits on: a few tries over about 15 s, then the error. */
  private async sendWithRetry(req: any, what: string) {
    const backoff = new Backoff([1000, 2000, 4000, 8000]);
    for (;;) {
      try {
        return await this.sendRequest(req, { retries: 0, timeoutMs: 20_000 });
      } catch (e: any) {
        if (backoff.failures >= 4 || (e instanceof MatrixError && e.status < 500 && !e.isRateLimit)) throw new Error(`${what} failed: ${e?.message ?? e}`);
        await backoff.sleep(backoff.fail());
      }
    }
  }

  /** A session we have no key for: ask the backup for just that one. Fetching a whole backup can be gigabytes, and most of it is never read. */
  wantSession(roomId: string, sessionId: string) {
    if (!this.backup) return;
    const id = `${roomId}|${sessionId}`;
    const tried = this.backupTried.get(id);
    if (tried !== undefined && Date.now() - tried < BACKUP_RETRY_MS) return;
    this.backupTried.set(id, Date.now());
    this.backupQueue.push({ roomId, sessionId });
    while (this.backupWorkers < BACKUP_WORKERS) {
      this.backupWorkers++;
      void this.backupWorker().finally(() => this.backupWorkers--);
    }
  }

  private async backupWorker() {
    for (let next = this.backupQueue.shift(); next && !this.stopped; next = this.backupQueue.shift()) {
      const b = this.backup;
      if (!b) return;
      try {
        const data: any = await this.opts.client().request('GET', `/_matrix/client/v3/room_keys/keys/${enc(next.roomId)}/${enc(next.sessionId)}`, { query: { version: b.version }, retries: 1 });
        const s = data?.session_data;
        const session = JSON.parse(b.key.decryptV1(s.ephemeral, s.mac, s.ciphertext));
        session.session_id = next.sessionId;
        session.room_id = next.roomId;
        // The library reports it through the room key callback, which is what retries the events.
        await this.machine.importBackedUpRoomKeys(new Map([[new M.RoomId(next.roomId), new Map([[next.sessionId, session]])]]), undefined as any, b.version);
      } catch (e: any) {
        if (!(e instanceof MatrixError && (e.status === 404 || e.errcode === 'M_NOT_FOUND'))) this.opts.log('warn', `could not restore a key from the backup: ${e?.message ?? e}`);
      }
    }
  }

  // ---------------------------------------------------------------- verification with another of your devices

  /** One verification step at a time: a sync, a timer and a tap must not interleave (two of them could both start SAS). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.verifyLock.then(fn, fn);
    this.verifyLock = run.catch(() => {});
    return run;
  }

  private currentRequest(): M.VerificationRequest | undefined {
    return this.flow ? this.machine.getVerificationRequest(new M.UserId(this.opts.userId), this.flow.id) : undefined;
  }

  /** A flow is going on (not one that ended): the adapter syncs more eagerly meanwhile. */
  get verifying(): boolean {
    return this.flow !== null;
  }

  private setVerification(v: VerificationState | null) {
    if (JSON.stringify(v) === JSON.stringify(this.verification)) return;
    this.verification = v;
    this.opts.onVerification(v);
  }

  /** Show the state again, e.g. after the outbox changed. */
  private publish() {
    if (!this.stopped) this.tickVerification().catch((e) => this.opts.log('warn', `verification: ${e.message}`));
  }

  /** Drive the flow from what the machine says now. Runs after each sync, each action, and when a send fails or recovers. */
  private tickVerification(): Promise<void> {
    return this.locked(() => this.tick());
  }

  private async tick(): Promise<void> {
    const user = new M.UserId(this.opts.userId);
    // Every request lives 10 minutes, so the one with the most time left is the newest.
    const live = this.machine
      .getVerificationRequests(user)
      .filter((r) => !r.isDone() && !r.isCancelled() && !r.timedOut() && !r.isPassive())
      .sort((a, b) => b.timeRemainingMillis() - a.timeRemainingMillis());
    let req = this.currentRequest();
    if (this.flow && (!req || req.isDone() || req.isCancelled() || req.timedOut())) {
      await this.endFlow(req);
      req = undefined;
    }
    const newest = live[0];
    if (this.flow && req && newest && newest.flowId !== req.flowId && newest.timeRemainingMillis() > req.timeRemainingMillis()) {
      this.opts.log('info', 'verification: a newer request replaces the one in progress');
      await this.cancelFlow(req, true);
      this.flow = null;
    }
    if (!this.flow) {
      if (!newest) return this.setVerification(this.endedShown());
      for (const stale of live.slice(1)) await this.cancelFlow(stale, true);
      this.flow = { id: newest.flowId, sasSince: null };
      this.ended = null;
      this.verificationResult = null;
      req = newest;
    }
    req = req ?? this.currentRequest()!;
    const flow = this.flow!;
    const otherDevice = req.otherDeviceId?.toString() ?? null;
    const base: VerificationState = {
      flowId: req.flowId,
      phase: 'waiting',
      otherDevice,
      otherDeviceName: otherDevice ? await this.deviceName(otherDevice) : null,
      weStarted: req.weStarted(),
      expiresAt: Date.now() + req.timeRemainingMillis(),
      ...(this.pendingFor(req.flowId) ? { sending: this.pendingFor(req.flowId) } : {}),
    };
    // Stable between ticks, so an unchanged state is not sent again every sync.
    base.expiresAt = Math.round(base.expiresAt! / 1000) * 1000;
    const phase = req.phase();
    if (phase === M.VerificationRequestPhase.Requested || phase === M.VerificationRequestPhase.Created) {
      return this.setVerification({ ...base, phase: !req.weStarted() && phase === M.VerificationRequestPhase.Requested ? 'requested' : 'waiting' });
    }
    if (phase === M.VerificationRequestPhase.Ready) {
      // We asked and they said yes: they are looking at their screen now, so start at once. When they asked,
      // they start. Starting for them would start the emoji step's one-minute clock while their app may be
      // in the background; the user can still tap "Show emoji" here.
      if (req.weStarted()) {
        const started = await req.startSas();
        if (started) {
          flow.sasSince = Date.now();
          await this.deliver(started[1], req.flowId);
          return this.tick();
        }
      }
      return this.setVerification({ ...base, phase: 'ready' });
    }
    const sas = req.getVerification();
    if (!(sas instanceof M.Sas)) return this.setVerification(base);
    flow.sasSince ??= Date.now();
    if (!sas.weStarted() && !sas.hasBeenAccepted()) await this.deliver(sas.accept(), req.flowId);
    const heard = Math.max(this.lastIncoming.get(req.flowId) ?? 0, flow.sasSince);
    const sasBase = { ...base, expiresAt: Math.min(base.expiresAt!, flow.sasSince + SAS_MAX_AGE_MS, heard + SAS_EVENT_TIMEOUT_MS) };
    if (sas.haveWeConfirmed()) return this.setVerification({ ...sasBase, phase: 'confirmed' });
    const emoji = sas.emoji();
    if (!sas.canBePresented() || !emoji) return this.setVerification(sasBase);
    this.setVerification({ ...sasBase, phase: 'compare', emoji: emoji.map((e) => ({ symbol: e.symbol, description: e.description })), decimals: Array.from(sas.decimals() ?? []) });
  }

  private async deviceName(deviceId: string): Promise<string | null> {
    const d = await this.machine.getDevice(new M.UserId(this.opts.userId), new M.DeviceId(deviceId)).catch(() => undefined);
    return d?.displayName ?? null;
  }

  private endedShown(): VerificationState | null {
    if (this.ended && Date.now() - (this.ended.endedAt ?? 0) > ENDED_SHOWN_MS) this.ended = null;
    return this.ended;
  }

  /** The flow in `this.flow` is over: verified, or say why not. */
  private async endFlow(req: M.VerificationRequest | undefined) {
    const flowId = this.flow!.id;
    this.flow = null;
    this.lastIncoming.delete(flowId);
    if (req?.isDone()) {
      this.verificationResult = 'verified';
      this.ended = null;
      await this.afterVerified();
      return;
    }
    const sas = req?.getVerification();
    const info = req?.cancelInfo ?? (sas instanceof M.Sas ? sas.cancelInfo() : undefined);
    const code = info?.cancelCode() ?? (req?.timedOut() ? 'm.timeout' : '');
    const byUs = info ? info.cancelledbyUs() : true;
    const reason = info?.reason() ?? (req?.timedOut() ? 'The verification process timed out.' : 'The verification was dropped.');
    this.verificationResult = reason;
    const otherDevice = req?.otherDeviceId?.toString() ?? this.verification?.otherDevice ?? null;
    this.opts.log('info', `verification with ${otherDevice ?? 'another device'} ended without verifying: ${reason} (${code || 'no code'}, ${byUs ? 'by this device' : 'by the other device'})`);
    if (this.replaced.delete(flowId) || this.userCancelled.delete(flowId)) return;
    const outcome: VerificationState['outcome'] = code === 'm.timeout' ? 'timeout' : code === 'm.mismatched_sas' && byUs ? 'mismatch' : 'cancelled';
    this.ended = {
      flowId,
      phase: 'ended',
      otherDevice,
      otherDeviceName: otherDevice ? await this.deviceName(otherDevice) : null,
      outcome,
      reason,
      cancelledBy: byUs ? 'us' : 'them',
      endedAt: Date.now(),
    };
  }

  private userCancelled = new Set<string>();

  private async afterVerified() {
    this.opts.log('info', 'verification with another device finished');
    // Now that it trusts us, that device will answer for the backup key and the cross-signing keys.
    await this.machine.requestMissingSecretsIfNeeded();
    await this.flush().catch(() => {});
  }

  /**
   * A tap in the UI. Messages go out through the outbox: a network error does not fail the step, it is
   * retried, and the state shows it as "sending".
   */
  verifyAction(op: string): Promise<void> {
    return this.locked(async () => {
      const user = new M.UserId(this.opts.userId);
      if (op === 'start') {
        const own: any = await this.machine.getIdentity(user);
        if (!own?.requestVerification) throw new Error('this account has no cross-signing identity to verify against; set one up in another client first, or use the recovery key');
        // One flow at a time: the library would cancel the new request too if an old one were still open.
        for (const r of this.machine.getVerificationRequests(user)) if (!r.isDone() && !r.isCancelled()) await this.cancelFlow(r, true);
        if (this.flow) await this.endFlow(this.currentRequest());
        const [req, out] = await own.requestVerification([M.VerificationMethod.SasV1]);
        this.flow = { id: req.flowId, sasSince: null };
        this.ended = null;
        this.verificationResult = null;
        await this.deliver(out, req.flowId);
        return this.tick();
      }
      if (op === 'dismiss') {
        this.ended = null;
        return this.tick();
      }
      const req = this.currentRequest();
      if (!req) throw new Error(this.ended ? 'that verification is over; start again' : 'no verification is in progress');
      const sas = req.getVerification();
      switch (op) {
        case 'accept':
          await this.deliver(req.acceptWithMethods([M.VerificationMethod.SasV1]), req.flowId);
          break;
        case 'sas': {
          if (req.phase() !== M.VerificationRequestPhase.Ready) break; // started already, by either side
          const started = await req.startSas();
          if (started) {
            this.flow!.sasSince = Date.now();
            await this.deliver(started[1], req.flowId);
          }
          break;
        }
        case 'confirm': {
          if (!(sas instanceof M.Sas) || !sas.emoji()) throw new Error('there are no emoji to confirm yet');
          const outs = (await sas.confirm()).filter(Boolean);
          await Promise.all(outs.map((o) => this.deliver(o, req.flowId)));
          break;
        }
        case 'mismatch':
          await this.cancelFlow(req, false, 'm.mismatched_sas');
          break;
        case 'cancel':
          this.userCancelled.add(req.flowId);
          await this.cancelFlow(req, false);
          break;
        default:
          throw new Error(`unknown verification step "${op}"`);
      }
      return this.tick();
    });
  }

  // ---------------------------------------------------------------- status

  async status() {
    const user = new M.UserId(this.opts.userId);
    const device = await this.machine.getDevice(user, new M.DeviceId(this.opts.deviceId)).catch(() => undefined);
    const cross = await this.machine.crossSigningStatus();
    const counts = await this.machine.roomKeyCounts();
    return {
      active: true,
      userId: this.opts.userId,
      deviceId: this.opts.deviceId,
      /** Compare this with what another client shows for this device. */
      fingerprint: this.identity.ed25519,
      verified: !!device?.isCrossSigningTrusted(),
      crossSigning: { master: cross.hasMaster, selfSigning: cross.hasSelfSigning, userSigning: cross.hasUserSigning },
      backup: this.backup ? { version: this.backup.version, enabled: await this.machine.isBackupEnabled() } : null,
      roomKeys: counts.total,
      verification: this.verification,
      lastVerification: this.verificationResult,
      lastError: this.lastFlushError,
      hasIdentity: !!(await this.machine.getIdentity(user).catch(() => undefined)),
    };
  }
}

/** Server-supplied user ids go through the library's parser, and one bad id must not sink a whole batch. */
function toUserId(u: unknown): M.UserId[] {
  try {
    return typeof u === 'string' ? [new M.UserId(u)] : [];
  } catch {
    return [];
  }
}
