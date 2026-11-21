/**
 * Approvals (docs/approver.md "Approvals"): the bytes an approver device signs, the request a device is shown, and the
 * checks on both. The statement's format is dither-chat's contract (its docs/approvals.md, "The statement"), and the
 * hub and its CLI verify the very same bytes, so this follows dither-chat's packages/approvals/src/statement.ts byte
 * for byte. No I/O: the manager, the desk signer and the tests use it.
 */
import { createHash } from 'node:crypto';

export const STATEMENT_V1 = 'dither-approval-v1';
/** What the identity key signs in the `keys` frame, before deviceId, kind and the approval key. */
export const KEY_STATEMENT_V1 = 'dither-approver-key-v1';
export const DEVICE_KINDS = ['phone', 'desk'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** The asker's part of the statement. */
export interface Ask {
  id: string;
  kind: string;
  asker: string;
  created: number;
  expires: number;
  payloadSha256: string;
  displaySha256: string;
}

/** The device's part. */
export interface Answer {
  action: string;
  messageSha256: string;
  device: string;
  signed: number;
}

export type Statement = Ask & Answer;

export interface Action {
  id: string;
  label: string;
  needs: 'signed' | 'any';
}

/** What a device shows, and checks against the ask's hashes. */
export interface Display {
  kind: string;
  asker: string;
  title: string;
  body: string;
  payload: string;
  urgency: 'high' | 'normal' | 'low';
  actions: Action[];
}

export const ID_RE = /^apv_[A-Za-z0-9_-]{22}$/;
export const NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DEVICE_RE = /^dev_[A-Za-z0-9_-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MS = /^(0|[1-9][0-9]{0,15})$/;
export const MAX_TITLE = 200;
export const MAX_BODY = 32 * 1024;
export const MAX_PAYLOAD = 4 * 1024;
export const MAX_MESSAGE = 1000;
export const MAX_ACTIONS = 8;

export const sha256hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

/** A title as it is kept and hashed: one line, no control characters, at most 200 characters. */
export const cleanTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE);
/** display-sha256: what the device showed, title and body. */
export const displayHash = (title: string, body: string) => sha256hex(`${title}\n\n${body}`);
/** message-sha256: of the message's UTF-8, of "" when there is none. */
export const messageHash = (message: string | null | undefined) => sha256hex(message ?? '');

const lines = (ls: string[]) => ls.map((l) => `${l}\n`).join('');

export function askText(a: Ask): string {
  return lines([STATEMENT_V1, `id ${a.id}`, `kind ${a.kind}`, `asker ${a.asker}`, `created ${a.created}`, `expires ${a.expires}`, `payload-sha256 ${a.payloadSha256}`, `display-sha256 ${a.displaySha256}`]);
}

export function answerText(a: Answer): string {
  return lines([`action ${a.action}`, `message-sha256 ${a.messageSha256}`, `device ${a.device}`, `signed ${a.signed}`]);
}

export const statementText = (s: Statement) => askText(s) + answerText(s);

const ASK_KEYS = ['id', 'kind', 'asker', 'created', 'expires', 'payload-sha256', 'display-sha256'];
const ANSWER_KEYS = ['action', 'message-sha256', 'device', 'signed'];

function fields(text: string, keys: string[]): Record<string, string> | string {
  if (!text.endsWith('\n')) return 'it ends with a newline';
  const ls = text.slice(0, -1).split('\n');
  if (ls[0] !== STATEMENT_V1) return `not a ${STATEMENT_V1} statement`;
  if (ls.length !== keys.length + 1) return `it has exactly ${keys.length} fields`;
  const v: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    const line = ls[i + 1]!;
    const sp = line.indexOf(' ');
    if (sp < 0 || line.slice(0, sp) !== keys[i]) return `field ${i + 1} should be ${keys[i]}`;
    v[keys[i]!] = line.slice(sp + 1);
  }
  if (!ID_RE.test(v.id!)) return 'a bad id';
  // Any well-formed kind: the hub may add kinds (the contract grows by adding), and it checks its own.
  if (!NAME_RE.test(v.kind!)) return 'a bad kind';
  if (!NAME_RE.test(v.asker!)) return 'a bad asker';
  for (const k of ['payload-sha256', 'display-sha256', 'message-sha256']) if (k in v && !HEX64.test(v[k]!)) return `a bad ${k}`;
  for (const k of ['created', 'expires', 'signed']) if (k in v && !MS.test(v[k]!)) return `a bad ${k}`;
  if ('action' in v && !NAME_RE.test(v.action!)) return 'a bad action';
  if ('device' in v && !DEVICE_RE.test(v.device!)) return 'a bad device';
  return v;
}

const askOf = (v: Record<string, string>): Ask => ({ id: v.id!, kind: v.kind!, asker: v.asker!, created: Number(v.created), expires: Number(v.expires), payloadSha256: v['payload-sha256']!, displaySha256: v['display-sha256']! });

/** The asker's eight lines, or why they aren't. Canonical only: one text per ask, so nothing can hide in the bytes. */
export function parseAsk(text: string): Ask | string {
  const v = fields(text, ASK_KEYS);
  if (typeof v === 'string') return `the ask: ${v}`;
  const a = askOf(v);
  return askText(a) === text ? a : 'the ask is not in canonical form';
}

/** A whole statement (ask and answer), or why it isn't one. */
export function parseStatement(text: string): Statement | string {
  const v = fields(text, [...ASK_KEYS, ...ANSWER_KEYS]);
  if (typeof v === 'string') return v;
  const s: Statement = { ...askOf(v), action: v.action!, messageSha256: v['message-sha256']!, device: v.device!, signed: Number(v.signed) };
  return statementText(s) === text ? s : 'not in canonical form';
}

const URGENCIES = ['high', 'normal', 'low'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `display` as a device may show it: well formed, actions with deny among them (deny never needs a signature). */
export function parseDisplay(v: unknown): Display | string {
  if (!isObj(v)) return 'display is an object';
  const { kind, asker, title, body, payload, urgency, actions } = v;
  if (typeof kind !== 'string' || !NAME_RE.test(kind)) return 'display.kind';
  if (typeof asker !== 'string' || !NAME_RE.test(asker)) return 'display.asker';
  if (typeof title !== 'string' || !title || cleanTitle(title) !== title) return 'display.title: one line, at most 200 characters';
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) return 'display.body: text, at most 32 KiB';
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD || !/^[\x20-\x7e\n]*$/.test(payload)) return 'display.payload: printable ASCII, at most 4 KiB';
  if (urgency !== undefined && !URGENCIES.includes(urgency as string)) return 'display.urgency: high, normal or low';
  if (!Array.isArray(actions) || !actions.length || actions.length > MAX_ACTIONS) return `display.actions: 1 to ${MAX_ACTIONS}`;
  const out: Action[] = [];
  for (const a of actions) {
    if (!isObj(a) || typeof a.id !== 'string' || !NAME_RE.test(a.id)) return 'an action has an id like approve';
    if (out.some((x) => x.id === a.id)) return `action ${a.id} twice`;
    if (a.needs !== 'signed' && a.needs !== 'any') return `action ${a.id}: needs is signed or any`;
    if (a.label !== undefined && (typeof a.label !== 'string' || a.label.length > 100 || /[\u0000-\u001f\u007f]/.test(a.label))) return `action ${a.id}: a label is one line, at most 100 characters`;
    out.push({ id: a.id, label: (a.label as string | undefined) || a.id, needs: a.needs });
  }
  const deny = out.find((a) => a.id === 'deny');
  if (!deny) return 'the actions include deny';
  if (deny.needs !== 'any') return 'deny never needs a signature';
  return { kind, asker, title, body, payload, urgency: (urgency as Display['urgency'] | undefined) ?? 'normal', actions: out };
}

/**
 * The checks a device runs before it shows a request (and the manager before it sends one): the ask parses, is for
 * this id, its hashes are of the display's payload and title and body, its kind and asker are the display's, and it has
 * not expired. The ask and display, or why not.
 */
export function checkRequest(r: { id?: unknown; ask?: unknown; display?: unknown }, now = Date.now()): { ask: Ask; display: Display } | string {
  if (typeof r.ask !== 'string' || r.ask.length > 1000) return 'ask is the statement’s eight asker lines';
  const ask = parseAsk(r.ask);
  if (typeof ask === 'string') return ask;
  if (r.id !== undefined && r.id !== ask.id) return 'the ask is for another request';
  const display = parseDisplay(r.display);
  if (typeof display === 'string') return display;
  if (sha256hex(display.payload) !== ask.payloadSha256) return 'payload-sha256 is not the payload’s';
  if (displayHash(display.title, display.body) !== ask.displaySha256) return 'display-sha256 is not the title’s and body’s';
  if (display.kind !== ask.kind || display.asker !== ask.asker) return 'the ask’s kind and asker are not the display’s';
  if (ask.expires <= now) return 'it has expired';
  return { ask, display };
}

// ------------------------------------------------------------------ signatures

/** A DER ECDSA signature as WebCrypto's raw r‖s (64 bytes for P-256), or null when it isn't one. */
export function rawSignature(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  let i = 2;
  const int = (): Uint8Array | null => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1]!;
    if (len < 1 || len > 33 || i + 2 + len > der.length) return null;
    let v = der.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (!r || !s || i !== der.length) return null;
  const out = new Uint8Array(64);
  out.set(r);
  out.set(s, 32);
  return out;
}

/** A raw r‖s signature as DER (what devices send and trailers carry). */
export function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.subarray(1);
    if (v[0]! & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32, 64));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

/** SHA-256 of an SPKI's bytes, the first 8 as colon-joined hex: the fingerprint a device shows. */
export const fingerprint = (spkiB64: string) => sha256hex(Buffer.from(spkiB64, 'base64')).slice(0, 16).match(/../g)!.join(':');

export async function importKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', Buffer.from(spkiB64, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Whether `signature` (base64url DER) is the key's over `text`. */
export async function verifySignature(spkiB64: string, text: string, signature: string): Promise<boolean> {
  try {
    const raw = rawSignature(fromB64u(signature));
    if (!raw) return false;
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(spkiB64), raw as BufferSource, new TextEncoder().encode(text) as BufferSource);
  } catch {
    return false;
  }
}

/** `text` signed with a P-256 private key: base64url DER, as devices send it. */
export async function signText(key: CryptoKey, text: string): Promise<string> {
  return b64u(derSignature(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(text) as BufferSource))));
}

/** What the identity key signs in the `keys` frame. */
export const keyStatement = (deviceId: string, kind: string, approval: string) => `${KEY_STATEMENT_V1}\n${deviceId}\n${kind}\n${approval}`;
