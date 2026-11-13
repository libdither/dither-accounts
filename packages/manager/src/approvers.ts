/**
 * The approver's manager side (docs/approver.md): the paired phones (<data>/approvers.json, 0600, written whole), the
 * one-time pairing codes, each phone's link (GET /approver/ws), and the requests extractors send to them.
 *
 * - Pairing: the page makes a code (16 random bytes, 10 minutes, one use); the app sends it with its identity key to
 *   POST /approver/pair, outside the page's login: the code is the authority, compared in constant time.
 * - The link: a challenge, a hello signed with the identity key (else 4401), the push endpoint, pings. Requests wait
 *   per device until a link takes them, one at a time, or they expire; a device answers only its own.
 * - The wake-up: a request waiting for a device without a link POSTs exactly {"t":"wake"} to its UnifiedPush endpoint.
 * - Every request and its outcome goes to the `approval` table (never client data or keys) and the daily counts.
 */
import type { ServerWebSocket } from 'bun';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { answerOf, type ApproverAnswer, fingerprint, p256Key, rawSignature } from '@dither-accounts/passkey';
import type { ApprovalInfo, ApproverDeviceInfo } from './api-types.ts';
import type { Row, Store } from './db.ts';

export interface Device {
  id: string;
  name: string;
  /** The identity key's SPKI, base64. */
  publicKey: string;
  /** Its UnifiedPush endpoint (https), if it gave one. */
  push: string | null;
  pairedAt: number;
  lastSeenAt: number | null;
}

export interface ApproverSocketData {
  kind: 'approver';
  nonce: string;
  /** Set once its hello checked out. */
  device?: string;
  verifying?: boolean;
  lastHeard: number;
  helloTimer?: Timer;
}

interface Waiting {
  id: string;
  device: string;
  account: string;
  op: 'create' | 'get';
  msg: Record<string, unknown>;
  expiresAt: number;
  sent: boolean;
  timer: Timer;
  resolve: (a: ApproverAnswer) => void;
}

/** A pairing code lasts this long. */
export const PAIR_MS = 10 * 60_000;
/** A request waits this long for its device (the doc's 3 minutes). */
export const REQUEST_MS = 3 * 60_000;
const PING_MS = 30_000;
const SILENT_MS = 90_000;
const HELLO_MS = 15_000;
/** At most this often a device is woken again while its requests wait. */
const WAKE_GAP_MS = 5_000;

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest();
/** Its text without control characters, trimmed and cut. */
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export class Approvers {
  private devices: Device[];
  private file: string;
  /** sha256(code) → when it expires. */
  private pairings: { hash: Buffer; expiresAt: number }[] = [];
  private links = new Map<string, ServerWebSocket<ApproverSocketData>>();
  private queues = new Map<string, Waiting[]>();
  private inflight = new Map<string, Waiting>();
  private lastWake = new Map<string, number>();
  private pinger: Timer;

  constructor(
    private store: Store,
    private opts: {
      dataDir: string;
      publicUrl: string;
      /** Tests only: a push endpoint may be plain http on this machine (a fake push server). */
      pushHttp?: boolean;
      /** Tests only: how long a request waits (REQUEST_MS). */
      requestMs?: number;
      /** Something the page shows changed (a request waits or ended, a device came or went). */
      onChange?: () => void;
      /** Counts an outcome in the daily audit (app `approver`). */
      count?: (account: string, op: string, outcome: string) => void;
      /** A request named a device that is not paired here (the manager's notices say so). */
      onNoDevice?: (account: string, rpId: string, op: 'create' | 'get') => void;
    },
  ) {
    this.file = join(opts.dataDir, 'approvers.json');
    const raw = readSecretFile<{ devices?: unknown }>(this.file, (m) => console.error(`[approvers] ${m}`));
    this.devices = Array.isArray(raw.devices) ? raw.devices.filter((d): d is Device => !!d && typeof d.id === 'string' && typeof d.publicKey === 'string') : [];
    // Requests that were waiting when the manager stopped are gone with it.
    store.run(`UPDATE approval SET outcome = 'error', message = 'the manager restarted', decided_at = ? WHERE outcome = 'waiting'`, Date.now());
    this.pinger = setInterval(() => this.ping(), PING_MS);
  }

  stop() {
    clearInterval(this.pinger);
    for (const q of [...this.queues.values()].flat()) this.finish(q, { ok: false, reason: 'error', message: 'the manager stopped' });
    for (const w of [...this.inflight.values()]) this.finish(w, { ok: false, reason: 'error', message: 'the manager stopped' });
    for (const ws of this.links.values()) ws.close(1001, 'the manager stopped');
  }

  private save() {
    writeSecretFile(this.file, { devices: this.devices });
  }

  device(id: unknown): Device | null {
    return typeof id === 'string' ? (this.devices.find((d) => d.id === id) ?? null) : null;
  }

  // ---------------------------------------------------------------- pairing

  /** A new one-time code (the page, behind its login), and the link the app opens. */
  newPairing(): { code: string; link: string; url: string; expiresAt: number } {
    const now = Date.now();
    const code = b64u(crypto.getRandomValues(new Uint8Array(16)));
    this.pairings = this.pairings.filter((p) => p.expiresAt > now).slice(-7);
    const expiresAt = now + PAIR_MS;
    this.pairings.push({ hash: sha(code), expiresAt });
    const url = this.opts.publicUrl;
    return { code, url, link: `dither-approver://pair?url=${encodeURIComponent(url)}&code=${code}`, expiresAt };
  }

  /** POST /approver/pair: { code, name, publicKey } → { deviceId }, or what is wrong and its status. */
  async pair(body: unknown): Promise<{ deviceId: string } | { error: string; status: number }> {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const name = clean(b.name, 64);
    if (typeof b.code !== 'string' || b.code.length > 64 || !name || typeof b.publicKey !== 'string' || b.publicKey.length > 400) return { error: 'send { code, name, publicKey }', status: 400 };
    try {
      await p256Key(b.publicKey);
    } catch {
      return { error: 'publicKey is not a P-256 SPKI (base64)', status: 400 };
    }
    // Every live code is compared, each in constant time; a match is used up.
    const now = Date.now();
    const h = sha(b.code);
    let hit = -1;
    this.pairings.forEach((p, i) => {
      if (timingSafeEqual(p.hash, h) && p.expiresAt > now) hit = i;
    });
    if (hit < 0) return { error: 'that pairing code is unknown, used or expired: make a new one on the page', status: 403 };
    this.pairings.splice(hit, 1);
    const spki = Buffer.from(b.publicKey, 'base64').toString('base64');
    if (this.devices.some((d) => d.publicKey === spki)) return { error: 'this key is already paired', status: 409 };
    const id = `dev_${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
    this.devices.push({ id, name, publicKey: spki, push: null, pairedAt: now, lastSeenAt: null });
    this.save();
    console.log(`[approvers] paired ${id} (${await fingerprint(spki)})`);
    this.opts.onChange?.();
    return { deviceId: id };
  }

  /** Forget a device: its link closes and whatever waits for it is refused (no-device). */
  remove(id: string): boolean {
    const d = this.device(id);
    if (!d) return false;
    this.devices = this.devices.filter((x) => x !== d);
    this.save();
    this.links.get(id)?.close(4401, 'this device was removed');
    this.links.delete(id);
    for (const w of [...(this.queues.get(id) ?? []), ...(this.inflight.has(id) ? [this.inflight.get(id)!] : [])]) this.finish(w, { ok: false, reason: 'no-device', message: 'the device was removed' });
    this.opts.onChange?.();
    return true;
  }

  async list(): Promise<ApproverDeviceInfo[]> {
    return Promise.all(this.devices.map(async (d) => ({ id: d.id, name: d.name, fingerprint: await fingerprint(d.publicKey), pairedAt: d.pairedAt, lastSeenAt: this.links.has(d.id) ? Date.now() : d.lastSeenAt, online: this.links.has(d.id), push: !!d.push, waiting: (this.queues.get(d.id)?.length ?? 0) + (this.inflight.has(d.id) ? 1 : 0) })));
  }

  /** The last `limit` requests, newest first. */
  approvals(limit = 100): ApprovalInfo[] {
    return this.store.all('SELECT * FROM approval ORDER BY created_at DESC LIMIT ?', limit).map((r: Row) => ({
      id: r.id,
      account: r.account,
      rpId: r.rp_id,
      op: r.op,
      device: r.device,
      reason: r.reason,
      outcome: r.outcome,
      message: r.message,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      decidedAt: r.decided_at,
    }));
  }

  // ---------------------------------------------------------------- the link

  open(ws: ServerWebSocket<ApproverSocketData>) {
    ws.data.helloTimer = setTimeout(() => !ws.data.device && ws.close(4401, 'no hello'), HELLO_MS);
    ws.send(JSON.stringify({ t: 'challenge', nonce: ws.data.nonce }));
  }

  async message(ws: ServerWebSocket<ApproverSocketData>, raw: string | Buffer) {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.length > 64 * 1024) return void ws.close(1009, 'too big');
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text);
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    } catch {
      return;
    }
    const d = ws.data;
    d.lastHeard = Date.now();
    if (!d.device) {
      if (d.verifying || m.t !== 'hello') return;
      d.verifying = true;
      const dev = await this.verify(m, d.nonce);
      d.verifying = false;
      if (!dev) return void ws.close(4401, 'unknown device or bad signature');
      clearTimeout(d.helloTimer);
      d.device = dev.id;
      const old = this.links.get(dev.id);
      this.links.set(dev.id, ws);
      if (old && old !== ws) old.close(4000, 'replaced by a newer link');
      dev.lastSeenAt = Date.now();
      this.save();
      ws.send(JSON.stringify({ t: 'ready', name: dev.name }));
      this.opts.onChange?.();
      this.pump(dev.id);
      return;
    }
    if (m.t === 'ping') return void ws.send(JSON.stringify({ t: 'pong' }));
    if (m.t === 'pong') return;
    if (m.t === 'push') return this.setPush(d.device, m.endpoint);
    if (m.t === 'response') return this.response(d.device, m);
  }

  close(ws: ServerWebSocket<ApproverSocketData>) {
    const d = ws.data;
    clearTimeout(d.helloTimer);
    if (!d.device || this.links.get(d.device) !== ws) return;
    this.links.delete(d.device);
    const dev = this.device(d.device);
    if (dev) {
      dev.lastSeenAt = Date.now();
      this.save();
    }
    // What it had taken and not answered waits for the next link.
    const w = this.inflight.get(d.device);
    if (w) {
      this.inflight.delete(d.device);
      w.sent = false;
      (this.queues.get(d.device) ?? this.queues.set(d.device, []).get(d.device)!).unshift(w);
    }
    this.opts.onChange?.();
  }

  /** The hello: a paired device's signature over "dither-approver-v1\n" + deviceId + "\n" + nonce. */
  private async verify(m: Record<string, unknown>, nonce: string): Promise<Device | null> {
    const dev = this.device(m.deviceId);
    if (!dev || typeof m.sig !== 'string' || m.sig.length > 200) return null;
    try {
      const { key } = await p256Key(dev.publicKey);
      const data = new TextEncoder().encode(`dither-approver-v1\n${dev.id}\n${nonce}`);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSignature(new Uint8Array(Buffer.from(m.sig, 'base64url'))) as BufferSource, data as BufferSource);
      // Removed while it was being checked.
      return ok && this.device(dev.id) ? dev : null;
    } catch {
      return null;
    }
  }

  private setPush(id: string, endpoint: unknown) {
    const dev = this.device(id);
    if (!dev) return;
    let push: string | null = null;
    if (typeof endpoint === 'string' && endpoint.length <= 2048) {
      try {
        const u = new URL(endpoint);
        if (u.protocol === 'https:' || (this.opts.pushHttp && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) push = u.href;
      } catch {}
      if (!push) return void console.log(`[approvers] ${id} sent a push endpoint that is not https: ignored`);
    } else if (endpoint !== null) return;
    dev.push = push;
    this.save();
  }

  private ping() {
    const now = Date.now();
    for (const ws of this.links.values()) {
      if (now - ws.data.lastHeard > SILENT_MS) ws.close(4408, 'silent for 90 s');
      else ws.send(JSON.stringify({ t: 'ping' }));
    }
  }

  // ---------------------------------------------------------------- requests

  /** The device this account keeps new passkeys on: its config's passkeyDevice. */
  private createDevice(account: Row): string | null {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(account.config || '{}');
    } catch {}
    return typeof cfg.passkeyDevice === 'string' && cfg.passkeyDevice ? cfg.passkeyDevice : null;
  }

  /**
   * An extractor's request (packages/passkey ApproverAsk) for `account`, which the manager names itself: sent to the
   * device when a link takes it, answered when the device answers or it expires. A string input it does not take is
   * refused before anything is sent.
   */
  request(account: Row, input: Record<string, unknown>): Promise<ApproverAnswer> {
    const op = input.op === 'create' || input.op === 'get' ? input.op : null;
    const s = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
    const rpId = s(input.rpId, 253);
    const origin = s(input.origin, 300);
    const cdj = s(input.clientDataJSON, 8192);
    if (!op || !rpId || !origin || !cdj) return Promise.resolve({ ok: false, reason: 'error', message: 'a malformed request' });
    let extra: Record<string, unknown>;
    if (op === 'create') {
      const c = (input.create ?? {}) as Record<string, any>;
      const rp = { id: s(c.rp?.id, 253), name: clean(c.rp?.name, 200) };
      const user = { id: s(c.user?.id, 100), name: clean(c.user?.name, 200), displayName: clean(c.user?.displayName, 200) };
      if (rp.id !== rpId || !user.id) return Promise.resolve({ ok: false, reason: 'error', message: 'a malformed create' });
      extra = { create: { rp, user, algs: [-7] } };
    } else {
      const allow = Array.isArray((input.get as any)?.allow) ? ((input.get as any).allow as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 1400).slice(0, 64) : [];
      extra = { get: { allow } };
    }
    const now = Date.now();
    const deviceId = typeof input.device === 'string' ? input.device : '';
    const id = `apr_${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
    const reason = clean(input.reason, 200) || (op === 'create' ? 'Add a passkey' : 'Sign in');
    this.store.run('INSERT INTO approval (id, account, rp_id, op, device, reason, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, account.id, rpId, op, deviceId.slice(0, 64), reason, 'waiting', now);
    const done = (a: ApproverAnswer) => {
      this.record(id, account.id, op, a);
      return a;
    };
    const dev = this.device(deviceId);
    if (!dev) {
      this.opts.onNoDevice?.(account.id, rpId, op);
      return Promise.resolve(done({ ok: false, reason: 'no-device', message: 'that device is not paired here' }));
    }
    // A refusal names the device, so the account can say where it was refused (docs/approver.md: what a refusal does).
    const named = (a: ApproverAnswer): ApproverAnswer => (a.ok ? a : { ...a, deviceName: dev.name });
    // New passkeys go only to the device the account's pane names.
    if (op === 'create' && this.createDevice(account) !== dev.id) return Promise.resolve(done(named({ ok: false, reason: 'refused', message: 'not the device this account keeps new passkeys on' })));
    const expiresAt = now + (this.opts.requestMs ?? REQUEST_MS);
    const msg = { t: 'request', id, op, account: { id: account.id, label: account.label, kind: account.kind }, reason, rpId, origin, clientDataJSON: cdj, expiresAt, ...extra };
    return new Promise<ApproverAnswer>((resolve) => {
      const w: Waiting = { id, device: dev.id, account: account.id, op, msg, expiresAt, sent: false, resolve: (a) => resolve(done(named(a))), timer: setTimeout(() => this.finish(w, { ok: false, reason: 'expired' }), expiresAt - now) };
      (this.queues.get(dev.id) ?? this.queues.set(dev.id, []).get(dev.id)!).push(w);
      this.opts.onChange?.();
      if (this.links.has(dev.id)) this.pump(dev.id);
      else void this.wake(dev);
    });
  }

  /** The next waiting request to its device's link, when it has one and nothing outstanding. */
  private pump(device: string) {
    const ws = this.links.get(device);
    const q = this.queues.get(device);
    if (!ws || this.inflight.has(device) || !q?.length) return;
    const w = q.shift()!;
    if (!q.length) this.queues.delete(device);
    w.sent = true;
    this.inflight.set(device, w);
    this.store.run('UPDATE approval SET sent_at = COALESCE(sent_at, ?) WHERE id = ?', Date.now(), w.id);
    ws.send(JSON.stringify(w.msg));
  }

  /** A device's answer: only to the request it was sent; anything else is dropped. */
  private response(device: string, m: Record<string, unknown>) {
    const w = this.inflight.get(device);
    if (!w || m.id !== w.id) return void console.log(`[approvers] ${device} answered a request it does not hold: dropped`);
    this.finish(w, answerOf(m, w.op));
  }

  private finish(w: Waiting, a: ApproverAnswer) {
    clearTimeout(w.timer);
    if (this.inflight.get(w.device) === w) this.inflight.delete(w.device);
    const q = this.queues.get(w.device);
    if (q) {
      const i = q.indexOf(w);
      if (i >= 0) q.splice(i, 1);
      if (!q.length) this.queues.delete(w.device);
    }
    w.resolve(a);
    this.opts.onChange?.();
    this.pump(w.device);
  }

  private record(id: string, account: string, op: string, a: ApproverAnswer) {
    const outcome = a.ok ? 'ok' : a.reason;
    this.store.run('UPDATE approval SET outcome = ?, message = ?, decided_at = ? WHERE id = ?', outcome, a.ok ? null : (a.message?.slice(0, 200) ?? null), Date.now(), id);
    this.store.run('DELETE FROM approval WHERE created_at < ?', Date.now() - 90 * 86_400_000);
    this.opts.count?.(account, `passkey.${op}`, a.ok ? 'ok' : a.reason === 'denied' ? 'denied' : 'error');
  }

  /** Its UnifiedPush endpoint gets exactly {"t":"wake"}: nothing about the account, the site or the reason. */
  private async wake(dev: Device) {
    const now = Date.now();
    if (!dev.push || this.links.has(dev.id) || now - (this.lastWake.get(dev.id) ?? 0) < WAKE_GAP_MS) return;
    this.lastWake.set(dev.id, now);
    try {
      const r = await fetch(dev.push, { method: 'POST', body: '{"t":"wake"}', headers: { 'content-type': 'application/json', ttl: String(REQUEST_MS / 1000), urgency: 'high' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!r.ok) console.log(`[approvers] the push server answered ${r.status} for ${dev.id}`);
    } catch (e) {
      console.log(`[approvers] could not wake ${dev.id}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }

  /** The first request waiting for this account, and the device it waits on (the account's status says so). */
  waitingFor(account: string): { device: string; name: string } | null {
    for (const w of [...this.inflight.values(), ...[...this.queues.values()].flat()]) if (w.account === account) return { device: w.device, name: this.device(w.device)?.name ?? w.device };
    return null;
  }
}
