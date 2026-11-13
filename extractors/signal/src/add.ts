/**
 * Adding on Signal (dither-chat docs/add.md): what a group link names, who counts as a message request, and the plain
 * sentences for what signal-cli says when a lookup, a join or an answer does not go through. Pure functions: the
 * calls are in adapter.ts, and nothing here talks to the network.
 */

import { createHmac } from 'node:crypto';
import { RpcError } from './rpc.ts';
import type { SigContact } from './types.ts';

// ------------------------------------------------------------------ group links

/** Fields of one protobuf message: length-delimited ones by number (the first of each), varints skipped. */
function protoFields(b: Uint8Array): Map<number, Uint8Array> | null {
  const out = new Map<number, Uint8Array>();
  let i = 0;
  const varint = (): number => {
    let v = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (i >= b.length) return -1;
      const x = b[i++];
      v += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) return v;
    }
    return -1;
  };
  while (i < b.length) {
    const tag = varint();
    if (tag < 0) return null;
    const wire = tag % 8;
    const field = Math.floor(tag / 8);
    if (wire === 2) {
      const n = varint();
      if (n < 0 || i + n > b.length) return null;
      if (!out.has(field)) out.set(field, b.subarray(i, i + n));
      i += n;
    } else if (wire === 0) {
      if (varint() < 0) return null;
    } else return null;
  }
  return out;
}

/**
 * The group master key a signal.group link carries, read from the link alone. The link is
 * https://signal.group/#<base64url of GroupInviteLink>, whose contentsV1 holds groupMasterKey (1) and
 * inviteLinkPassword (2). Null when it holds no 32-byte key.
 */
export function linkMasterKey(uri: string): Uint8Array | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'signal.group') return null;
  let frag: string;
  try {
    frag = decodeURIComponent(u.hash.slice(1));
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_+/=-]+$/.test(frag)) return null;
  const bytes = new Uint8Array(Buffer.from(frag.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url'));
  const v1 = protoFields(bytes)?.get(1);
  const key = v1 && protoFields(v1)?.get(1);
  return key?.length === 32 ? new Uint8Array(key) : null;
}

const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/**
 * A group's id from its master key, as libsignal's zkgroup derives it (GroupSecretParams.deriveFromMasterKey: the
 * first 32 bytes squeezed from an HMAC-SHA256 Sho under its label), base64 as signal-cli writes group ids. Checked
 * against libsignal itself in test/add.test.ts.
 */
export function groupIdOfMasterKey(masterKey: Uint8Array): string {
  const label = new TextEncoder().encode('Signal_ZKGroup_20200424_GroupMasterKey_GroupSecretParams_DeriveFromMasterKey');
  let cv = hmac(new Uint8Array(32), label, Uint8Array.of(0)); // absorb the label, ratchet
  cv = hmac(cv, masterKey, Uint8Array.of(0)); // absorb the key, ratchet
  const id = hmac(cv, new Uint8Array(8), Uint8Array.of(1)); // squeeze block 0
  return Buffer.from(id).toString('base64');
}

/** The id of the group a signal.group link leads to, or null when the link holds no group key. */
export function groupIdOfLink(uri: string): string | null {
  const key = linkMasterKey(uri);
  return key ? groupIdOfMasterKey(key) : null;
}

/** A signal.group link for a master key and link password, written as Signal's apps write one. */
export function groupLink(masterKey: Uint8Array, password: Uint8Array): string {
  const field = (n: number, b: Uint8Array) => [n * 8 + 2, b.length, ...b];
  const v1 = Uint8Array.from([...field(1, masterKey), ...field(2, password)]);
  return `https://signal.group/#${Buffer.from(Uint8Array.from(field(1, v1))).toString('base64url')}`;
}

// ------------------------------------------------------------------ message requests

/** Someone in your address book: the name signal-cli has for them came from a contact entry, not their profile. */
export const systemContact = (c: SigContact) => !!(c.name?.trim() || c.givenName?.trim() || c.familyName?.trim());

/**
 * Whether a 1:1 with someone who wrote to you, and whom you have not written to, is a message request, from what
 * signal-cli has for them (listContacts): the way Signal's apps decide. Accepted means profile sharing is on, which the
 * phone keeps in storage and signal-cli syncs (accepting, or writing to them, turns it on); someone in your address
 * book needs no accepting; blocked and unregistered people have no request. Nobody signal-cli knows: a request.
 */
export function isMessageRequest(c: SigContact | undefined): boolean {
  if (!c) return true;
  return !c.profileSharing && !c.isBlocked && !c.unregistered && !systemContact(c);
}

// ------------------------------------------------------------------ what signal-cli said, in sentences

export const errorText = (e: unknown) => String((e as { message?: unknown })?.message ?? e);

function inWords(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * When Signal is limiting this device, the sentence that says so and when it frees up: signal-cli puts the time in
 * its message ("Rate limit reached\nNext attempt may be tried at <ms> (<date>)") or a retryAfterSeconds in the error.
 */
export function rateLimitSentence(e: unknown, doing: string, now = Date.now()): string | null {
  const msg = errorText(e);
  const code = e instanceof RpcError ? e.code : undefined;
  if (code !== -5 && !/rate ?limit/i.test(msg)) return null;
  let at: number | undefined;
  const m = /may be (?:tried|provided) at (\d{10,})/i.exec(msg);
  if (m) at = Number(m[1]);
  if (at === undefined && e instanceof RpcError) {
    const s = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(JSON.stringify(e.data ?? null));
    if (s) at = now + Number(s[1]) * 1000;
  }
  if (at === undefined) return `Signal is limiting how often this device can ${doing} and did not say until when; try again later`;
  return at <= now ? `Signal was limiting how often this device can ${doing}; it frees up now` : `Signal is limiting how often this device can ${doing}; try again in ${inWords(at - now)}`;
}

/** Signal wants a captcha before it does any more (a proof-required challenge): a check only the owner can do. */
export const wantsCaptcha = (e: unknown) => /captcha|proof ?required|challenge/i.test(errorText(e));

/** A lookup by number, username or username link that found nobody, was refused, or failed, as one sentence. */
export function lookupError(e: unknown, what: 'number' | 'username' | 'username link'): Error {
  const msg = errorText(e);
  const limited = rateLimitSentence(e, 'look people up');
  if (limited) return new Error(limited);
  if (/unregistered|not registered|not found|\b404\b/i.test(msg)) return new Error(`No Signal account has this ${what}`);
  if (/invalid phone number/i.test(msg)) return new Error('Signal cannot use this as a phone number');
  if (/invalid|malformed|bad/i.test(msg)) return new Error(what === 'username link' ? 'This Signal username link is damaged' : 'This is not a Signal username');
  return new Error(`Signal could not look up this ${what}: ${msg}`);
}

/** joinGroup's errors as one sentence (signal-cli: "Group link is not valid: …", "Group link is invalid: …"). */
export function joinError(e: unknown): Error {
  const msg = errorText(e);
  const limited = rateLimitSentence(e, 'join groups');
  if (limited) return new Error(limited);
  if (/banned/i.test(msg)) return new Error('You were removed from this group, so its link no longer lets you in');
  if (/link is not valid|not active|inactive/i.test(msg)) return new Error('This group link has been reset or turned off');
  if (/link is invalid|not a signal group invitation link|incompatible version/i.test(msg)) return new Error('This is not a working Signal group link');
  return new Error(`Signal did not let this device join: ${msg}`);
}

/** Any other call's error, with a rate limit said as a sentence that says when it frees up. */
export function signalError(e: unknown, doing: string): Error {
  const limited = rateLimitSentence(e, doing);
  return limited ? new Error(limited) : e instanceof Error ? e : new Error(errorText(e));
}
