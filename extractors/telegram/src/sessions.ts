/**
 * The account's other sessions, for an app that stands in for the phone (docs/telegram.md, "Approving a sign-in"):
 * approving a sign-in on another device by the QR code it shows (auth.acceptLoginToken), listing the sessions
 * (account.getAuthorizations) and ending one (account.resetAuthorization). What Telegram answers is put here in the
 * shape the actions answer, without the IP, and its refusals in words a person can act on.
 */
import { rpcText, type tl } from './backend.ts';

/** A session as `approveLogin` answers it. `hash` (a 64-bit number as a string) is only for `endSession`. */
export interface ApprovedSession {
  hash: string;
  device: string;
  platform: string;
  app: string;
  appVersion: string;
  country: string | null;
  region: string | null;
  /** ms epoch */
  createdAt: number;
}

/** A session as `sessions` lists it. */
export interface SessionInfo extends ApprovedSession {
  /** This account's own session (Telegram gives it hash 0). */
  current: boolean;
  /** ms epoch */
  activeAt: number;
}

/** A refusal in words, for the app to show as it is. */
export class SessionError extends Error {}

export const NOT_SIGNED_IN = 'Telegram is not signed in on this account yet: sign in first';
export const LINK_MALFORMED = 'That is not a Telegram sign-in code. On the other device, choose to log in by QR code, and scan the code it shows.';
export const TOKEN_EXPIRED = 'That code has expired: show a new one on the other device';
export const TOKEN_USED = 'That code has already been used to sign in. If that was not you, find the session it made in your sessions and end it.';
export const TOKEN_UNKNOWN = 'Telegram does not know that code. Show a new one on the other device and scan it again.';
export const HASH_MALFORMED = 'Give the session\'s hash, as sessions lists it: {"hash": "…"}';
export const HASH_CURRENT = "That is this account's own session: sign it out with logout instead.";
export const HASH_UNKNOWN = 'There is no session with that hash any more: it may have ended already. List the sessions again.';
export const NOT_ENDED = 'Telegram did not end that session. List the sessions again and try once more.';

const TOKEN_BYTES = { min: 8, max: 1024 };

/**
 * The token in a QR code a device shows to sign in: `tg://login?token=<base64url>`, or the bare base64url token.
 * Anything else is refused with LINK_MALFORMED.
 */
export function parseLoginLink(input: unknown): Uint8Array {
  const raw = typeof input === 'string' ? input.trim() : '';
  let token: string;
  if (/^tg:/i.test(raw)) {
    const m = raw.match(/^tg:\/\/login\?(?:[^#]*&)?token=([^&#]*)/i);
    if (!m) throw new SessionError(LINK_MALFORMED);
    try {
      token = decodeURIComponent(m[1]);
    } catch {
      throw new SessionError(LINK_MALFORMED);
    }
  } else token = raw;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token)) throw new SessionError(LINK_MALFORMED);
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length < TOKEN_BYTES.min || bytes.length > TOKEN_BYTES.max) throw new SessionError(LINK_MALFORMED);
  return new Uint8Array(bytes);
}

/** A session's hash as the app gave it back: a signed 64-bit integer in decimal. */
export function parseSessionHash(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : typeof input === 'number' && Number.isSafeInteger(input) ? String(input) : '';
  if (!/^-?\d{1,20}$/.test(raw)) throw new SessionError(HASH_MALFORMED);
  const n = BigInt(raw);
  if (n < -(2n ** 63n) || n >= 2n ** 63n) throw new SessionError(HASH_MALFORMED);
  if (n === 0n) throw new SessionError(HASH_CURRENT);
  return n.toString();
}

const orNull = (s: string | undefined) => (s && s.trim() ? s : null);

export function approvedSession(a: tl.RawAuthorization): ApprovedSession {
  return {
    hash: a.hash.toString(),
    device: a.deviceModel,
    platform: a.platform,
    app: a.appName,
    appVersion: a.appVersion,
    country: orNull(a.country),
    region: orNull(a.region),
    createdAt: a.dateCreated * 1000,
  };
}

/** Never the IP. */
export function sessionInfo(a: tl.RawAuthorization): SessionInfo {
  const { hash, device, platform, app, appVersion, country, region, createdAt } = approvedSession(a);
  return { hash, current: !!a.current, device, platform, app, appVersion, country, region, createdAt, activeAt: a.dateActive * 1000 };
}

/** The current one first, then the most recently active. */
export const bySessionOrder = (a: SessionInfo, b: SessionInfo) => Number(b.current) - Number(a.current) || b.activeAt - a.activeAt;

/** What acceptLoginToken's refusal means, or null for one with no words of its own. */
export function approveRefusal(e: unknown): string | null {
  const t = rpcText(e);
  if (t === 'AUTH_TOKEN_EXPIRED') return TOKEN_EXPIRED;
  if (t === 'AUTH_TOKEN_ALREADY_ACCEPTED') return TOKEN_USED;
  if (/^AUTH_TOKEN_INVALID/.test(t)) return TOKEN_UNKNOWN;
  return null;
}

/** Telegram's refusal to let a session under a day old end others (or, should it say so, sign others in). */
export const isTooFresh = (e: unknown) => /^FRESH_RESET_AUTHORISATION_FORBIDDEN$|^SESSION_TOO_FRESH_/.test(rpcText(e));

const DAY_MS = 86_400_000;

function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

/**
 * FRESH_RESET_AUTHORISATION_FORBIDDEN in words, naming the session that is too new: this account's own (the one
 * making the call), from `current` when the list could be read.
 */
export function tooFreshMessage(what: 'end other sessions' | 'approve sign-ins', current: SessionInfo | null, now = Date.now()): string {
  const rule = `Telegram does not let a session that is less than a day old ${what}`;
  if (!current) return `${rule}, and this account's own session is that new. Try again tomorrow, or do it from a device that has been signed in for longer.`;
  const name = [current.app, current.device].filter(Boolean).join(' on ') || 'this account';
  const age = now - current.createdAt;
  const left = DAY_MS - age;
  const when = left > 60_000 ? `It can in about ${span(left)}` : 'Try again in a while';
  return `${rule}, and this account's own session (${name}, signed in ${span(age)} ago) is too new. ${when}; until then, do it from a device that has been signed in for longer.`;
}
