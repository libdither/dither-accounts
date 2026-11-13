/**
 * "The other client" for the integration test: a second device with its own OlmMachine
 * (same library, in memory), its own /sync loop, and nothing shared with the adapter under test
 * but the homeserver. Sends and reads the way a Matrix client does.
 */

import * as M from '@matrix-org/matrix-sdk-crypto-wasm';
import { enc, MatrixClient } from '../src/http.ts';
import type { MxEvent } from '../src/rooms.ts';

await M.initAsync();

export interface ClearEvent extends MxEvent {
  /** The event as the server stored it. */
  raw: MxEvent;
}

export class Peer {
  readonly seen: ClearEvent[] = [];
  /** An app in the background: no /sync, so nothing arrives and nothing queued goes out. */
  paused = false;
  private since: string | undefined;
  private running = true;
  private waiters: { pred: (e: ClearEvent) => boolean; res: (e: ClearEvent) => void }[] = [];
  private tracked = new Set<string>();
  readonly loop: Promise<void>;

  private constructor(
    readonly client: MatrixClient,
    readonly userId: string,
    readonly deviceId: string,
    readonly machine: M.OlmMachine,
  ) {
    this.loop = this.run();
  }

  static async login(baseUrl: string, user: string, password: string): Promise<Peer> {
    const client = new MatrixClient(baseUrl);
    const res = await client.request('POST', '/_matrix/client/v3/login', {
      auth: false,
      body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, initial_device_display_name: 'integration peer' },
    });
    client.accessToken = res.access_token;
    const machine = await M.OlmMachine.initialize(new M.UserId(res.user_id), new M.DeviceId(res.device_id));
    const peer = new Peer(client, res.user_id, res.device_id, machine);
    await peer.flush();
    return peer;
  }

  async stop() {
    this.running = false;
    await this.loop.catch(() => {});
    await this.client.request('POST', '/_matrix/client/v3/logout', { body: {} }).catch(() => {});
    this.machine.close();
  }

  private async run() {
    let synced = false;
    while (this.running) {
      if (this.paused) {
        await Bun.sleep(100);
        continue;
      }
      try {
        const res: any = await this.client.request('GET', '/_matrix/client/v3/sync', { query: { since: this.since, timeout: 500, set_presence: 'offline' }, timeoutMs: 30_000, retries: 0 });
        this.since = res.next_batch;
        const lists = new M.DeviceLists((res.device_lists?.changed ?? []).map((u: string) => new M.UserId(u)), (res.device_lists?.left ?? []).map((u: string) => new M.UserId(u)));
        await this.machine.receiveSyncChanges(JSON.stringify(res.to_device?.events ?? []), lists, new Map(Object.entries(res.device_one_time_keys_count ?? {})), new Set(res.device_unused_fallback_key_types ?? []), new M.DecryptionSettings(M.TrustRequirement.Untrusted));
        await this.flush();
        for (const [roomId, jr] of Object.entries<any>(res.rooms?.join ?? {})) {
          for (const ev of jr.timeline?.events ?? []) {
            if (ev.state_key !== undefined) continue;
            const clear = await this.clear(ev, roomId);
            if (synced || clear) {
              this.seen.push(clear);
              for (const w of [...this.waiters]) if (w.pred(clear)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.res(clear));
            }
          }
        }
        synced = true;
      } catch (e) {
        if (this.running) await Bun.sleep(200);
      }
    }
  }

  async clear(ev: MxEvent, roomId: string): Promise<ClearEvent> {
    if (ev.type !== 'm.room.encrypted') return { ...ev, raw: ev };
    try {
      const d = await this.machine.decryptRoomEvent(JSON.stringify(ev), new M.RoomId(roomId), new M.DecryptionSettings(M.TrustRequirement.Untrusted));
      const c = JSON.parse(d.event);
      return { ...ev, type: c.type, content: { ...c.content, 'm.relates_to': c.content?.['m.relates_to'] ?? ev.content['m.relates_to'] }, raw: ev };
    } catch {
      return { ...ev, raw: ev };
    }
  }

  waitFor(pred: (e: ClearEvent) => boolean, ms = 20_000): Promise<ClearEvent> {
    const past = this.seen.find(pred);
    if (past) return Promise.resolve(past);
    return new Promise((res, rej) => {
      const w = { pred, res: (e: ClearEvent) => (clearTimeout(t), res(e)) };
      const t = setTimeout(() => (this.waiters.splice(this.waiters.indexOf(w), 1), rej(new Error('peer timed out waiting for an event'))), ms);
      this.waiters.push(w);
    });
  }

  async send1(req: any) {
    const c = this.client;
    const json = { contentType: 'application/json', body: req.body };
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
      case M.RequestType.KeysBackup:
        res = await c.request('PUT', '/_matrix/client/v3/room_keys/keys', { ...json, query: { version: req.version } });
        break;
      default:
        throw new Error(`peer: unhandled request ${req.type}`);
    }
    if (req.id) await this.machine.markRequestAsSent(req.id, req.type, JSON.stringify(res));
  }

  async flush() {
    for (const r of await this.machine.outgoingRequests()) await this.send1(r);
  }

  private async prepare(roomId: string): Promise<M.UserId[]> {
    const res = await this.client.request('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/joined_members`);
    const users = Object.keys(res.joined);
    await this.machine.updateTrackedUsers(users.map((u) => new M.UserId(u)));
    await this.flush();
    const claim = await this.machine.getMissingSessions(users.map((u) => new M.UserId(u)));
    if (claim) await this.send1(claim);
    return users.map((u) => new M.UserId(u));
  }

  /** Create the room key for this room now. Returns the to-device messages that would hand it out, unsent. */
  async heldKeyShare(roomId: string): Promise<any[]> {
    const users = await this.prepare(roomId);
    const s = new M.EncryptionSettings();
    s.sharingStrategy = M.CollectStrategy.allDevices();
    return this.machine.shareRoomKey(new M.RoomId(roomId), users, s);
  }

  async rawSend(roomId: string, type: string, content: unknown): Promise<string> {
    const res = await this.client.request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/${enc(type)}/${enc(this.client.txnId())}`, { body: content });
    return res.event_id;
  }

  async send(roomId: string, type: string, content: unknown): Promise<string> {
    for (const r of await this.heldKeyShare(roomId)) await this.send1(r);
    return this.rawSend(roomId, 'm.room.encrypted', JSON.parse(await this.machine.encryptRoomEvent(new M.RoomId(roomId), type, JSON.stringify(content))));
  }

  /** Encrypt with whatever session is current, without sharing anything. */
  async sendWithoutShare(roomId: string, type: string, content: unknown): Promise<string> {
    return this.rawSend(roomId, 'm.room.encrypted', JSON.parse(await this.machine.encryptRoomEvent(new M.RoomId(roomId), type, JSON.stringify(content))));
  }

  /** New cross-signing keys for this user, uploaded. The homeserver wants the password for that. */
  async bootstrapCrossSigning(password: string) {
    const b = await this.machine.bootstrapCrossSigning(true);
    const upload = JSON.parse(b.uploadSigningKeysRequest.body);
    await this.client.request('POST', '/_matrix/client/v3/keys/device_signing/upload', {
      retries: 0,
      body: { ...upload, auth: { type: 'm.login.password', identifier: { type: 'm.id.user', user: this.userId }, password } },
    });
    await this.send1(b.uploadSignaturesRequest);
    await this.flush();
  }

  async setAccountData(type: string, content: unknown) {
    await this.client.request('PUT', `/_matrix/client/v3/user/${enc(this.userId)}/account_data/${enc(type)}`, { body: content });
  }

  /** A new room key backup on the server, with this device writing to it. */
  async createBackup(): Promise<{ key: M.BackupDecryptionKey; version: string }> {
    const key = M.BackupDecryptionKey.createRandomKey();
    const publicKey = key.megolmV1PublicKey.publicKeyBase64;
    const res = await this.client.request('POST', '/_matrix/client/v3/room_keys/version', { body: { algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2', auth_data: { public_key: publicKey } } });
    await this.machine.saveBackupDecryptionKey(key, res.version);
    await this.machine.enableBackupV1(publicKey, res.version);
    return { key, version: res.version };
  }

  async uploadBackup(): Promise<number> {
    let n = 0;
    for (let req = await this.machine.backupRoomKeys(); req; req = await this.machine.backupRoomKeys()) {
      await this.send1(req);
      n++;
    }
    return n;
  }
}

export { M };
