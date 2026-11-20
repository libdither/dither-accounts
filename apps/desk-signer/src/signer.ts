/**
 * The desk signer (apps/desk-signer/README.md, docs/approver.md "The desk signer"): an approver device of kind `desk`
 * that runs on a laptop as its own system user. It pairs with the manager like the phone, keeps its link, and signs an
 * approval only when the page asks it to (an `intent`) and the laptop's fingerprint reader reports your finger.
 *
 * Its state directory (0700) holds device.json and its two P-256 keys as PKCS8 (identity.pk8, approval.pk8), each 0600.
 * The identity key proves the device on every link; the approval key signs statements.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ask, checkRequest, type Display, fingerprint, keyStatement, MAX_MESSAGE, messageHash, signText, answerText } from '@dither-accounts/approval';

export interface DeviceFile {
  /** Where the manager is reached (its public URL, or what --url said). */
  url: string;
  deviceId: string;
  name: string;
  /** SPKI, base64. */
  publicKey: string;
  approvalKey: string;
  pairedAt: number;
}

export interface State {
  device: DeviceFile;
  identity: CryptoKey;
  approval: CryptoKey;
}

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const FILES = { device: 'device.json', identity: 'identity.pk8', approval: 'approval.pk8' };

/** Writes a file only its owner can read: a temp file, then renamed over. */
function writePrivate(path: string, data: string | Uint8Array) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** What the app reads from the QR: dither-approver://pair?url=…&code=… */
export function parseLink(link: string): { url: string; code: string } {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new Error('that is not a pairing link (dither-approver://pair?url=…&code=…)');
  }
  const url = u.searchParams.get('url');
  const code = u.searchParams.get('code');
  if (u.protocol !== 'dither-approver:' || u.host !== 'pair' || !url || !code) throw new Error('that is not a pairing link (dither-approver://pair?url=…&code=…)');
  return { url, code };
}

/**
 * Pairs with the manager the link names: makes the identity and approval keys, sends the identity key with the code,
 * and keeps both in `dir`. `base` reaches the manager somewhere else than the link's URL (a test, a tunnel).
 */
export async function pair(link: string, o: { dir: string; name: string; base?: string; force?: boolean }): Promise<DeviceFile> {
  const { url, code } = parseLink(link);
  const base = (o.base ?? url).replace(/\/$/, '');
  if (existsSync(join(o.dir, FILES.device)) && !o.force) throw new Error(`${o.dir} already holds a paired device: pass --force to pair again (the old one stays paired on the manager until you remove it there)`);
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  chmodSync(o.dir, 0o700);
  const gen = () => crypto.subtle.generateKey(P256, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  const [identity, approval] = [await gen(), await gen()];
  const spki = async (k: CryptoKey) => Buffer.from(await crypto.subtle.exportKey('spki', k)).toString('base64');
  const publicKey = await spki(identity.publicKey);
  const approvalKey = await spki(approval.publicKey);
  const r = await fetch(`${base}/approver/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: o.name, publicKey }) });
  if (!r.ok) throw new Error(`the manager refused the pairing (${r.status}): ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText}`);
  const { deviceId } = (await r.json()) as { deviceId: string };
  writePrivate(join(o.dir, FILES.identity), new Uint8Array(await crypto.subtle.exportKey('pkcs8', identity.privateKey)));
  writePrivate(join(o.dir, FILES.approval), new Uint8Array(await crypto.subtle.exportKey('pkcs8', approval.privateKey)));
  const device: DeviceFile = { url: base, deviceId, name: o.name, publicKey, approvalKey, pairedAt: Date.now() };
  writePrivate(join(o.dir, FILES.device), `${JSON.stringify(device, null, 2)}\n`);
  return device;
}

/** What `status` says: the device, its fingerprints, and whether its files are private. */
export function describe(dir: string): { device: DeviceFile; identityFingerprint: string; approvalFingerprint: string; problems: string[] } {
  const device = JSON.parse(readFileSync(join(dir, FILES.device), 'utf8')) as DeviceFile;
  return { device, identityFingerprint: fingerprint(device.publicKey), approvalFingerprint: fingerprint(device.approvalKey), problems: privacyProblems(dir) };
}

function privacyProblems(dir: string): string[] {
  const out: string[] = [];
  if (statSync(dir).mode & 0o077) out.push(`${dir} can be read by others (want 0700)`);
  for (const f of Object.values(FILES)) if (existsSync(join(dir, f)) && statSync(join(dir, f)).mode & 0o077) out.push(`${f} can be read by others (want 0600)`);
  return out;
}

/** The paired device and its keys (not extractable once loaded). Refuses files others can read. */
export async function load(dir: string): Promise<State> {
  if (!existsSync(join(dir, FILES.device))) throw new Error(`${dir} holds no paired device: run "desk-signer pair <link>" first`);
  const problems = privacyProblems(dir);
  if (problems.length) throw new Error(`refusing keys others can read: ${problems.join('; ')}`);
  const device = JSON.parse(readFileSync(join(dir, FILES.device), 'utf8')) as DeviceFile;
  const key = (f: string) => crypto.subtle.importKey('pkcs8', readFileSync(join(dir, f)), P256, false, ['sign']);
  return { device, identity: await key(FILES.identity), approval: await key(FILES.approval) };
}

export interface PresenceResult {
  ok: boolean;
  why: string;
}

/**
 * The presence check: the command (default `fprintd-verify <user>`) must exit 0 and say `verify-match` within the
 * timeout. `{user}` in the command is replaced by the user.
 */
export async function presence(command: string[], user: string, timeoutMs = 30_000): Promise<PresenceResult> {
  const argv = command.map((a) => a.replaceAll('{user}', user));
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (e) {
    return { ok: false, why: `could not run ${argv[0]}: ${(e as Error).message}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  clearTimeout(timer);
  if (timedOut) return { ok: false, why: `no finger within ${Math.round(timeoutMs / 1000)} s` };
  if (code === 0 && /\bverify-match\b/.test(`${out}\n${err}`)) return { ok: true, why: 'verify-match' };
  return { ok: false, why: /verify-no-match/.test(`${out}\n${err}`) ? 'the finger did not match' : `${argv[0]} exited ${code} without a match` };
}

interface Kept {
  ask: Ask;
  askText: string;
  display: Display;
  timer: Timer;
}

export interface SignerOpts {
  /** The user whose finger counts ($DESK_SIGNER_USER). */
  user: string;
  /** The presence check's command; `{user}` is replaced ($DESK_SIGNER_VERIFY, a JSON array). */
  verify?: string[];
  verifyTimeoutMs?: number;
  log?: (line: string) => void;
  /** The manager said this device is not paired (4401): the caller stops. */
  onUnpaired?: (reason: string) => void;
  /** Tests: told of each frame it gets and each answer it sends. */
  onFrame?: (dir: 'in' | 'out', m: Record<string, unknown>) => void;
}

const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60_000;
const SILENT_MS = 90_000;

/** The signer's link: kept open, keys sent, requests kept, intents answered after the presence check. */
export class DeskSigner {
  readonly requests = new Map<string, Kept>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = BACKOFF_MIN;
  private retry?: Timer;
  private watchdog?: Timer;
  private lastHeard = 0;
  private checking: string | null = null;
  ready = false;

  constructor(
    private st: State,
    private o: SignerOpts,
  ) {}

  private log(line: string) {
    (this.o.log ?? ((l: string) => console.log(`[desk-signer] ${l}`)))(line);
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && this.ready && Date.now() - this.lastHeard > SILENT_MS) this.ws.close(4408, 'silent');
    }, 15_000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.watchdog);
    this.ws?.close(1000, 'stopping');
    this.ws = null;
    for (const k of this.requests.values()) clearTimeout(k.timer);
    this.requests.clear();
  }

  private connect() {
    const url = `${this.st.device.url.replace(/^http/, 'ws')}/approver/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (e) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.lastHeard = Date.now();
      this.o.onFrame?.('in', m);
      void this.onFrame(ws, m).catch((err) => this.log(`a ${String(m.t)} frame failed: ${(err as Error).message}`));
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.ws = null;
      this.ready = false;
      // What it held came on that link: the next one sends it again.
      for (const k of this.requests.values()) clearTimeout(k.timer);
      this.requests.clear();
      if (this.stopped) return;
      if (e.code === 4401) {
        this.log(`the manager says this device is not paired (${e.reason}): stopping`);
        this.stopped = true;
        this.o.onUnpaired?.(e.reason);
        return;
      }
      this.log(`link closed (${e.code}${e.reason ? ` ${e.reason}` : ''}); again in ${Math.round(this.backoff / 1000)} s`);
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
    };
    ws.onerror = () => {};
  }

  private send(ws: WebSocket, m: Record<string, unknown>) {
    this.o.onFrame?.('out', m);
    ws.send(JSON.stringify(m));
  }

  private async onFrame(ws: WebSocket, m: Record<string, unknown>) {
    const d = this.st.device;
    switch (m.t) {
      case 'challenge': {
        const sig = await signText(this.st.identity, `dither-approver-v1\n${d.deviceId}\n${String(m.nonce)}`);
        return this.send(ws, { t: 'hello', deviceId: d.deviceId, sig, app: 'desk-signer/1' });
      }
      case 'ready': {
        this.backoff = BACKOFF_MIN;
        const sig = await signText(this.st.identity, keyStatement(d.deviceId, 'desk', d.approvalKey));
        this.send(ws, { t: 'keys', kind: 'desk', approval: d.approvalKey, sig });
        this.ready = true;
        this.log(`linked to ${d.url} as ${d.deviceId}`);
        return;
      }
      case 'ping':
        return this.send(ws, { t: 'pong' });
      case 'request':
        return this.onRequest(ws, m);
      case 'cancel': {
        const k = this.requests.get(String(m.id));
        if (k) {
          clearTimeout(k.timer);
          this.requests.delete(String(m.id));
        }
        return;
      }
      case 'intent':
        return this.onIntent(ws, m);
    }
  }

  /** Checked as the phone checks it, then kept until an intent, a cancel or its expiry. It never answers on its own. */
  private onRequest(ws: WebSocket, m: Record<string, unknown>) {
    const id = String(m.id);
    if (m.op !== 'approve') return this.send(ws, { t: 'response', id, ok: false, reason: 'refused', message: 'a desk signer holds no passkeys' });
    if (this.requests.has(id)) return;
    const c = checkRequest(m);
    if (typeof c === 'string') {
      this.log(`refused ${id}: ${c}`);
      return this.send(ws, { t: 'response', id, ok: false, reason: c === 'it has expired' ? 'expired' : 'refused' });
    }
    const timer = setTimeout(() => this.requests.delete(id), Math.min(2 ** 31 - 1, c.ask.expires - Date.now()));
    this.requests.set(id, { ask: c.ask, askText: m.ask as string, display: c.display, timer });
    this.log(`holding ${id}: ${c.display.kind} from ${c.display.asker}: ${c.display.title}`);
  }

  /** The page asked to sign this action: the finger first (for one that needs a signature), then the answer. */
  private async onIntent(ws: WebSocket, m: Record<string, unknown>) {
    const id = String(m.id);
    const k = this.requests.get(id);
    if (!k) return this.log(`an intent for ${id}, which it does not hold: ignored`);
    const action = k.display.actions.find((a) => a.id === m.action);
    if (!action) return this.log(`an intent for ${id} with an action it was not offered: ignored`);
    if (m.message != null && (typeof m.message !== 'string' || m.message.length > MAX_MESSAGE)) return this.log(`an intent for ${id} with a message over ${MAX_MESSAGE} characters: ignored`);
    const message = (m.message as string | null | undefined) || null;
    if (action.needs === 'any') {
      this.requests.delete(id);
      clearTimeout(k.timer);
      return this.send(ws, { t: 'response', id, ok: true, op: 'approve', action: action.id, message, signed: Date.now() });
    }
    if (this.checking) return this.log(`an intent for ${id} while the reader is busy with ${this.checking}: ignored`);
    this.checking = id;
    this.log(`touch the fingerprint reader to ${action.label} "${k.display.title}" (${k.display.kind} from ${k.display.asker})`);
    let r: PresenceResult;
    try {
      r = await presence(this.o.verify ?? ['fprintd-verify', '{user}'], this.o.user, this.o.verifyTimeoutMs);
    } finally {
      this.checking = null;
    }
    if (this.ws !== ws || this.requests.get(id) !== k) return this.log(`${id} went away during the fingerprint check: nothing signed`);
    if (!r.ok) {
      this.log(`not signed: ${r.why}`);
      return this.send(ws, { t: 'response', id, ok: false, reason: 'error', message: r.why });
    }
    if (k.ask.expires <= Date.now()) return this.send(ws, { t: 'response', id, ok: false, reason: 'expired' });
    const signed = Date.now();
    const statement = k.askText + answerText({ action: action.id, messageSha256: messageHash(message), device: this.st.device.deviceId, signed });
    const signature = await signText(this.st.approval, statement);
    this.requests.delete(id);
    clearTimeout(k.timer);
    this.log(`signed ${action.id} for ${id}`);
    this.send(ws, { t: 'response', id, ok: true, op: 'approve', action: action.id, message, signed, signature });
  }
}
