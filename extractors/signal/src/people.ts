/**
 * People, this account and this device, beyond messages (docs/signal.md, "People and this device"): safety numbers,
 * blocking, your nicknames and notes, your own profile and username, linked devices and captchas. Pure helpers; the
 * adapter calls signal-cli and keeps the state.
 *
 * As signal-cli 0.14.8 has them:
 *   listIdentities  [{ number, uuid, fingerprint, safetyNumber, scannableSafetyNumber, trustLevel, addedTimestamp }],
 *                   one per person it has a key for. No event says a key changed (e12): a key whose fingerprint is
 *                   not the one last seen has changed, and `addedTimestamp` says when it came.
 *   trust           { recipient, verifiedSafetyNumber } marks that key verified; { recipient, trustAllKnownKeys }
 *                   trusts it unverified again (Signal's "Clear verification").
 *   updateContact   { recipient, nickGivenName?, nickFamilyName?, note? }: a field not given is kept, '' clears it,
 *                   and it goes to your phone (storage sync). It also un-hides the contact.
 *   updateProfile   { givenName?, familyName?, about?, aboutEmoji?, avatar? (a file), removeAvatar? }.
 *   updateAccount   { username } answers { username, usernameLink }; { deleteUsername }; { deviceName }.
 *                   Your username link can be read only by setting a username (e8).
 *   listDevices     [{ id, name, createdTimestamp, lastSeenTimestamp }]. A linked device cannot remove itself:
 *                   removeDevice is primary-only, and unregister on a linked device only marks it unregistered here.
 *   submitRateLimitChallenge { challenge, captcha }.
 */
import type { PersonAbout, SafetyNumber } from '@dither-chat/protocol';

/** One row of signal-cli's listIdentities. */
export interface SigIdentity {
  number?: string | null;
  uuid?: string | null;
  fingerprint?: string | null;
  safetyNumber?: string | null;
  scannableSafetyNumber?: string | null;
  trustLevel?: 'UNTRUSTED' | 'TRUSTED_UNVERIFIED' | 'TRUSTED_VERIFIED' | string | null;
  addedTimestamp?: number | null;
}

/** One row of signal-cli's listDevices. */
export interface SigDevice {
  id: number;
  name?: string | null;
  createdTimestamp?: number | null;
  lastSeenTimestamp?: number | null;
}

/** A person's key as last seen: its fingerprint, when it came, and when it last changed (unset until it does). */
export interface KnownKey {
  f: string;
  a: number;
  c?: number;
}

/** Where Signal's rate-limit captcha is solved, as signal-cli says it. */
export const CAPTCHA_URL = 'https://signalcaptchas.org/challenge/generate.html';

const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : null);

/** Signal's safety number for a protocol PersonAbout. */
export function safetyOf(id: SigIdentity, known?: KnownKey): SafetyNumber | undefined {
  const digits = (id.safetyNumber ?? '').replace(/\s+/g, '');
  if (!digits) return undefined;
  const trust = id.trustLevel === 'TRUSTED_VERIFIED' ? 'verified' : id.trustLevel === 'UNTRUSTED' ? 'untrusted' : 'unverified';
  return { digits, ...(id.scannableSafetyNumber ? { scannable: id.scannableSafetyNumber } : {}), trust, ...(known?.c ? { changedAt: known.c } : {}) };
}

/**
 * A listIdentities read against the keys seen before: who has a new key since, and the keys as they are now. The first
 * read (nothing seen before) changes nobody. A person missing from this read keeps what was seen.
 */
export function keyChanges(before: Map<string, KnownKey>, rows: SigIdentity[], now = Date.now()): { changed: { aci: string; at: number }[]; keys: Map<string, KnownKey> } {
  const keys = new Map(before);
  const changed: { aci: string; at: number }[] = [];
  const first = before.size === 0;
  for (const r of rows) {
    const aci = lc(r.uuid);
    const f = r.fingerprint?.replace(/\s+/g, '');
    if (!aci || !f) continue;
    const was = before.get(aci);
    const added = typeof r.addedTimestamp === 'number' && r.addedTimestamp > 0 ? r.addedTimestamp : now;
    if (!was) {
      keys.set(aci, { f, a: added });
      continue;
    }
    if (was.f === f) continue;
    keys.set(aci, { f, a: added, c: added });
    if (!first) changed.push({ aci, at: added });
  }
  return { changed, keys };
}

/** A safety number as typed or copied (spaces, dashes, line breaks), as signal-cli's trust takes it: the digits. */
export function cleanSafetyNumber(s: unknown): string {
  if (typeof s !== 'string') throw new Error('A safety number is 60 digits');
  const d = s.replace(/[\s-]+/g, '');
  if (!/^\d{60}$/.test(d)) throw new Error('A safety number is 60 digits');
  return d;
}

const joined = (...parts: (string | null | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(' ');

/**
 * A whole name as Signal's two fields. The family name stays where it was when the new name still ends with it (an
 * edit of the given name keeps the split the phone made); otherwise it all goes in the given name.
 */
export function splitName(full: string, now: { given?: string | null; family?: string | null }): { given: string; family: string } {
  const name = full.trim().replace(/\s+/g, ' ');
  const family = now.family?.trim() ?? '';
  if (family && name.endsWith(` ${family}`) && name.length > family.length + 1) return { given: name.slice(0, -family.length - 1), family };
  return { given: name, family: '' };
}

/** Your nickname for them as Signal keeps it, as one name ('' when none). */
export const nicknameOf = (c: { nickGivenName?: string | null; nickFamilyName?: string | null; nickName?: string | null }) => joined(c.nickGivenName, c.nickFamilyName) || joined(c.nickName);

/** The most a Signal nickname or note takes is not documented; these keep a slip from being stored whole. */
export const NICKNAME_MAX = 100;
export const NOTE_MAX = 2000;

/**
 * updateContact's params for a nickname and note change from dither, or null when Signal has them so already. Only
 * the fields given are sent, so the other stays as the phone has it.
 */
export function contactChange(
  c: { nickGivenName?: string | null; nickFamilyName?: string | null; nickName?: string | null; note?: string | null } | undefined,
  change: { nickname?: unknown; note?: unknown },
): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (change.nickname !== undefined) {
    if (typeof change.nickname !== 'string') throw new Error('A nickname is text');
    const nick = change.nickname.trim().replace(/\s+/g, ' ');
    if ([...nick].length > NICKNAME_MAX) throw new Error(`A nickname takes ${NICKNAME_MAX} characters at most`);
    if (nick !== nicknameOf(c ?? {})) {
      const { given, family } = splitName(nick, { given: c?.nickGivenName, family: c?.nickFamilyName });
      out.nickGivenName = given;
      out.nickFamilyName = family;
    }
  }
  if (change.note !== undefined) {
    if (typeof change.note !== 'string') throw new Error('A note is text');
    const note = change.note.trim();
    if ([...note].length > NOTE_MAX) throw new Error(`A note takes ${NOTE_MAX} characters at most`);
    if (note !== (c?.note?.trim() ?? '')) out.note = note;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A username as updateAccount takes it: the nickname part (3 to 32 letters, digits or _, not starting with a digit),
 * or a whole name.12 to keep those digits. Signal adds the digits when none are given.
 */
export function cleanUsername(u: unknown): string {
  if (typeof u !== 'string') throw new Error('A username is text');
  const s = u.trim().replace(/^@/, '');
  const m = /^([A-Za-z_][A-Za-z0-9_]{2,31})(?:\.(\d{2,9}))?$/.exec(s);
  if (!m) throw new Error('A Signal username is 3 to 32 letters, digits or _, not starting with a digit (Signal adds a number after a dot)');
  return s;
}

/** The challenge in a send's or a call's rate-limit failure: a result's `token`, or the one in the error's data. */
export function challengeOf(x: unknown): string | null {
  const results = (r: any): any[] => (Array.isArray(r?.results) ? r.results : Array.isArray(r?.response?.results) ? r.response.results : []);
  const from = (r: any) => results(r).find((y) => y?.type === 'RATE_LIMIT_FAILURE' && typeof y.token === 'string' && y.token)?.token ?? null;
  return from(x) ?? from((x as { data?: unknown } | null)?.data) ?? null;
}

/** The captcha as the owner pasted it: the link "Open Signal" points at, or its token alone. */
export function cleanCaptcha(s: unknown): string {
  if (typeof s !== 'string' || !s.trim()) throw new Error('Paste the link that "Open Signal" points at after solving the captcha');
  const t = s.trim().replace(/^signalcaptcha:\/\//, '');
  if (/\s/.test(t) || t.length < 20) throw new Error('That does not look like a Signal captcha token');
  return t;
}

/** This device among the account's devices, as signal-cli's account file numbers it. */
export function devicesDetail(devices: SigDevice[], thisId: number | null, now = Date.now()): string {
  const day = 86_400_000;
  const seen = (t?: number | null) => (!t ? '' : now - t < day ? ', seen today' : `, seen ${Math.round((now - t) / day)} d ago`);
  return devices
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((d) => `${d.name || (d.id === 1 ? 'Phone' : 'Unnamed')} #${d.id}${d.id === 1 ? ' (primary)' : ''}${d.id === thisId ? ' (this one)' : seen(d.lastSeenTimestamp)}`)
    .join('; ');
}

/** What a username link shows: your username and the link, when updateAccount said them. */
export function usernameOf(r: { username?: string | null; usernameLink?: string | null } | null | undefined): PersonAbout['username'] | undefined {
  if (!r?.username) return undefined;
  return { name: r.username, ...(r.usernameLink ? { link: r.usernameLink } : {}) };
}
