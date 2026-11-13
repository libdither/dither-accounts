/**
 * The account's own self on Discord (dither-chat's docs/account-self.md, protocol self.ts): what the hook reads of it
 * (the required action, standing, settings proto, whom you ignore) into notices and state for the hub, and the self
 * commands (block, ignore, notes, presence, sessions, profile fields) into hook commands. Pure functions, tested in
 * test/self.test.ts.
 */

import type * as P from '@dither-chat/protocol';
import { SELF_LIMITS } from '@dither-chat/protocol';
import type { RawProfile } from './discord-types.ts';

// ---------------------------------------------------------------- what the hook sends

/** What Discord wants done: the gateway's required action, the standing once the client read it, your age check. */
export interface RawSelfNotices {
  requiredAction: string | null;
  /** SafetyHub standing: 100 all good, 200 limited, 300 very limited, 400 at risk, 500 suspended. null: not read. */
  standing: number | null;
  /** The user's age verification status, as the client's user record has it. */
  age: number | null;
}

/** Your settings as the client's settings store has them. */
export interface RawSelfState {
  status: string | null;
  statusExpiresAt: number | null;
  custom: { text: string | null; emojiId: string | null; emojiName: string | null; expiresAt: number | null } | null;
  folders: { id: string | null; name: string | null; color: number | null; guildIds: string[] }[] | null;
  privacy: { restrictedGuilds: number; defaultGuildsRestricted: boolean; requestRestrictedGuilds: number; defaultRequestRestricted: boolean | null };
}

export type RawSelfUp =
  | { t: 'self'; part: 'notices'; data: RawSelfNotices }
  | { t: 'self'; part: 'state'; data: RawSelfState }
  | { t: 'self'; part: 'ignored'; data: string[] };

/** One place you are signed in, as the client's Devices page has it. */
export interface RawSession {
  id: string;
  current: boolean;
  os: string | null;
  platform: string | null;
  location: string | null;
  last_used: string | null;
}

export type SelfHookCommand =
  /** reply RawSelfState after: your status and custom status written through the client's settings path. */
  | { kind: 'selfPresence'; state?: P.OwnPresenceState; status?: { text?: string; emojiName?: string; emojiId?: string; expiresAt?: number } | null }
  /** reply RawFriend (add.ts): blocked, as the client's Block button does. */
  | { kind: 'selfBlock'; userId: string }
  /** reply { ignored }: ignored or not, as the client's Ignore button does, checked against its store. */
  | { kind: 'selfIgnore'; userId: string; ignored: boolean }
  /** reply { note }: your note on them saved. */
  | { kind: 'selfNote'; userId: string; note: string }
  /** reply { sessions: RawSession[] }. */
  | { kind: 'selfSessions' }
  /** reply RawProfile of yourself: your profile beyond the bio saved, pictures as base64. */
  | {
      kind: 'selfProfile';
      bio?: string;
      displayName?: string;
      pronouns?: string;
      avatar?: { mime: string; base64: string } | null;
      banner?: { mime: string; base64: string } | null;
      accent?: string | null;
    };

// ---------------------------------------------------------------- capabilities

/** The self capabilities this client can do, by the modules the hook found. */
export function selfCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = [];
  if (found.RelationshipActions && found.RelationshipStore) caps.push('block', 'ignore');
  if (found.Rest) caps.push('contactNotes', 'sessions');
  if (found.SettingsActions && found.UserSettingsProtoStore) caps.push('setPresence');
  return caps;
}

// ---------------------------------------------------------------- notices

const LIVE = 'Open the live view to do it there; dither does not do it for you.';

/** Discord's required actions in words. The key is the action itself, so a new one still shows. */
const REQUIRED: Record<string, { kind: P.AccountNotice['kind']; title: string; what: string }> = {
  REQUIRE_VERIFIED_EMAIL: { kind: 'verify', title: 'Verify your email', what: "Discord wants this account's email address verified before it carries on." },
  REQUIRE_VERIFIED_PHONE: { kind: 'verify', title: 'Verify your phone number', what: 'Discord wants a verified phone number on this account before it carries on.' },
  REQUIRE_REVERIFIED_EMAIL: { kind: 'verify', title: 'Verify your email again', what: "Discord wants this account's email address verified again." },
  REQUIRE_REVERIFIED_PHONE: { kind: 'verify', title: 'Verify your phone number again', what: "Discord wants this account's phone number verified again." },
  REQUIRE_VERIFIED_EMAIL_OR_VERIFIED_PHONE: { kind: 'verify', title: 'Verify your email or phone', what: 'Discord wants a verified email address or phone number on this account.' },
  REQUIRE_REVERIFIED_EMAIL_OR_VERIFIED_PHONE: { kind: 'verify', title: 'Verify your email or phone', what: 'Discord wants your email verified again, or a verified phone number.' },
  REQUIRE_VERIFIED_EMAIL_OR_REVERIFIED_PHONE: { kind: 'verify', title: 'Verify your email or phone', what: 'Discord wants a verified email address, or your phone number verified again.' },
  REQUIRE_REVERIFIED_EMAIL_OR_REVERIFIED_PHONE: { kind: 'verify', title: 'Verify your email or phone again', what: 'Discord wants your email or your phone number verified again.' },
  REQUIRE_CAPTCHA: { kind: 'verify', title: 'Solve a captcha', what: 'Discord wants a captcha solved on this account.' },
  AGREEMENTS: { kind: 'agreements', title: "Agree to Discord's terms", what: "Discord wants its updated Terms of Service and Privacy Policy agreed to before this account carries on." },
  REQUIRE_SAFETY_FLOWS: { kind: 'age', title: "Finish Discord's safety check", what: "Discord wants a safety check finished on this account, often an age check." },
};

const STANDING: Record<number, string> = { 200: 'limited', 300: 'very limited', 400: 'at risk of suspension', 500: 'suspended' };

export function noticesOf(raw: RawSelfNotices): P.AccountNotice[] {
  const out: P.AccountNotice[] = [];
  const a = typeof raw?.requiredAction === 'string' && raw.requiredAction ? raw.requiredAction : null;
  if (a) {
    const r = REQUIRED[a] ?? { kind: 'other' as const, title: 'Discord wants something done', what: `Discord says this account must do something first (${a}).` };
    out.push({ key: `required:${a}`, kind: r.kind, title: r.title, message: `${r.what} ${LIVE}`, liveView: true });
  }
  const s = typeof raw?.standing === 'number' ? STANDING[raw.standing >= 500 ? 500 : raw.standing >= 400 ? 400 : raw.standing >= 300 ? 300 : raw.standing >= 200 ? 200 : 0] : undefined;
  if (s)
    out.push({
      key: 'standing',
      kind: 'standing',
      title: `Your account is ${s}`,
      message: `Discord's Safety Hub says this account is ${s}. Open the live view (User Settings, Family Center & Safety) to read why, and to appeal there if you want.`,
      liveView: true,
    });
  return out;
}

// ---------------------------------------------------------------- state

const STATES: readonly P.OwnPresenceState[] = ['online', 'idle', 'dnd', 'invisible'];
const hex = (n: number | null) => (typeof n === 'number' && n >= 0 && n <= 0xffffff ? `#${n.toString(16).padStart(6, '0')}` : undefined);

/** An age check's outcome as the client's user record says it. Unknown values are left out. */
const AGE: Record<number, string> = { 1: 'Not done', 2: 'Verified (teen)', 3: 'Verified (adult)', 4: 'Taken as adult' };

export function stateOf(raw: RawSelfState, age: number | null = null, now = Date.now()): P.SelfState {
  const out: P.SelfState = {};
  if (raw.status && STATES.includes(raw.status as P.OwnPresenceState)) {
    const c = raw.custom;
    const live = c && (!c.expiresAt || c.expiresAt > now);
    const emoji = live && c!.emojiName ? (c!.emojiId ? `:${c!.emojiName}:` : c!.emojiName) : undefined;
    const status = live && (c!.text || emoji) ? { ...(c!.text ? { text: c!.text } : {}), ...(emoji ? { emoji } : {}), ...(c!.expiresAt ? { expiresAt: c!.expiresAt } : {}) } : undefined;
    out.presence = { state: raw.status as P.OwnPresenceState, ...(raw.statusExpiresAt && raw.statusExpiresAt > now ? { until: raw.statusExpiresAt } : {}), ...(status ? { status } : {}) };
  }
  if (raw.folders)
    out.folders = raw.folders.map((f) => ({
      ...(f.id ? { id: f.id } : {}),
      ...(f.name ? { name: f.name } : {}),
      ...(hex(f.color) ? { color: hex(f.color) } : {}),
      spaces: f.guildIds,
    }));
  const p = raw.privacy;
  if (p) {
    const except = (n: number, word: string) => (n ? `, ${word} in ${n} ${n === 1 ? 'server' : 'servers'}` : '');
    out.privacy = [
      { label: 'Direct messages from server members', value: p.defaultGuildsRestricted ? `Off for new servers${except(p.restrictedGuilds, 'off')}` : `Allowed in new servers${except(p.restrictedGuilds, 'off')}` },
      ...(p.defaultRequestRestricted === null ? [] : [{ label: 'Message requests from server members', value: `${p.defaultRequestRestricted ? 'Off' : 'On'} for new servers${except(p.requestRestrictedGuilds, 'off')}` }]),
      ...(age !== null && AGE[age] ? [{ label: 'Age check', value: AGE[age] }] : []),
    ];
  }
  return out;
}

/** The events one part from the hook makes. */
export function selfEvents(msg: RawSelfUp, age: number | null): P.AdapterEvent[] {
  if (msg.part === 'notices') return [{ t: 'notices', notices: noticesOf(msg.data) }];
  if (msg.part === 'state') return [{ t: 'selfState', state: stateOf(msg.data, age) }];
  if (msg.part === 'ignored') return [{ t: 'ignored', identities: (Array.isArray(msg.data) ? msg.data : []).filter((x) => typeof x === 'string') }];
  return [];
}

// ---------------------------------------------------------------- commands

/** setPresence as the hook takes it: a Unicode emoji only (a server's own one cannot be named by text). */
export function presenceCommand(change: P.PresenceChange): Extract<SelfHookCommand, { kind: 'selfPresence' }> {
  const out: Extract<SelfHookCommand, { kind: 'selfPresence' }> = { kind: 'selfPresence' };
  if (change.state !== undefined) {
    if (!STATES.includes(change.state)) throw new Error('unknown status');
    out.state = change.state;
  }
  if (change.status === null) out.status = null;
  else if (change.status) {
    const s = change.status;
    const limit = SELF_LIMITS.discord!.statusText!;
    const text = (s.text ?? '').trim();
    if ([...text].length > limit) throw new Error(`a Discord status takes ${limit} characters, this one has ${[...text].length}`);
    const emoji = (s.emoji ?? '').trim();
    if (/^:[\w~-]+:$/.test(emoji)) throw new Error("A server's own emoji cannot be set from here: pick a standard emoji, or set it in the live view");
    out.status = text || emoji ? { ...(text ? { text } : {}), ...(emoji ? { emojiName: emoji } : {}), ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}) } : null;
  }
  if (out.state === undefined && out.status === undefined) throw new Error('nothing to change');
  return out;
}

/** OwnPresence after a change, from the state the hook read back. */
export function presenceOf(raw: RawSelfState | null | undefined, now = Date.now()): P.OwnPresence {
  return (raw && stateOf(raw, null, now).presence) ?? { state: 'online' };
}

export function sessionsOf(raw: { sessions?: RawSession[] } | null | undefined): P.SessionsResult {
  const list = Array.isArray(raw?.sessions) ? raw!.sessions : [];
  return {
    sessions: list
      .filter((s) => s && typeof s.id === 'string' && s.id)
      .map((s) => {
        const at = s.last_used ? Date.parse(s.last_used) : NaN;
        return {
          id: s.id,
          ...(s.current ? { current: true } : {}),
          ...(s.platform ? { client: s.platform } : {}),
          ...(s.os ? { os: s.os } : {}),
          ...(s.location ? { location: s.location } : {}),
          ...(Number.isFinite(at) ? { lastUsed: at } : {}),
        };
      }),
  };
}

/** What setProfile takes on Discord: the profile's `editable` (profile.ts). */
export const EDITABLE: P.ProfileField[] = ['bio', 'name', 'avatar', 'pronouns', 'banner', 'accent'];

/** Your note on someone as Discord keeps it, checked before any request (256 characters). */
export function contactNote(note: string): string {
  const n = [...note].length;
  const limit = SELF_LIMITS.discord!.note!;
  if (n > limit) throw new Error(`a Discord note takes ${limit} characters, this one has ${n}`);
  return note;
}

/**
 * Your note on them from a profile the hook read, as an identity fact (contactNotes): '' when Discord has none. null
 * when the hook could not say (it failed to ask), so a note the hub holds is never taken for cleared.
 */
export function noteFact(raw: RawProfile, who: string): P.AdapterEvent | null {
  if (who === raw.selfId || raw.note === undefined) return null;
  return { t: 'identity', identity: { nativeId: who, note: typeof raw.note === 'string' ? raw.note : '' } };
}

/** The fields beyond the bio a change carries; none means the old bio-only path. */
export const moreThanBio = (c: P.ProfileChange) => (Object.keys(c) as (keyof P.ProfileChange)[]).some((k) => k !== 'bio' && c[k] !== undefined);

/**
 * setProfile beyond the bio, checked here before any request: Discord's own lengths, pictures read from the spool.
 * `read` gives a file's bytes as base64 (main.ts reads the hub's spool).
 */
export function profileCommand(c: P.ProfileChange, read: (path: string) => string): Extract<SelfHookCommand, { kind: 'selfProfile' }> {
  const lim = SELF_LIMITS.discord!;
  const len = (s: string) => [...s].length;
  const out: Extract<SelfHookCommand, { kind: 'selfProfile' }> = { kind: 'selfProfile' };
  if (c.bio !== undefined) {
    if (len(c.bio) > 190) throw new Error(`a Discord bio takes 190 characters, this one has ${len(c.bio)}`);
    out.bio = c.bio;
  }
  if (c.emoji !== undefined || c.username !== undefined) throw new Error('Discord has no emoji by the bio, and its username changes only in the live view');
  if (c.name !== undefined) {
    if (len(c.name) > lim.name!) throw new Error(`a Discord display name takes ${lim.name} characters, this one has ${len(c.name)}`);
    out.displayName = c.name;
  }
  if (c.pronouns !== undefined) {
    if (len(c.pronouns) > lim.pronouns!) throw new Error(`Discord pronouns take ${lim.pronouns} characters, these have ${len(c.pronouns)}`);
    out.pronouns = c.pronouns;
  }
  const pic = (f: P.OutgoingAttachment | null | undefined) => {
    if (f === null) return null;
    if (!f) return undefined;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) throw new Error('Discord takes a PNG, JPEG, GIF or WebP picture');
    if (f.size > lim.avatarBytes!) throw new Error(`Discord takes pictures up to ${lim.avatarBytes! / 1024 / 1024} MB`);
    return { mime: f.mime, base64: read(f.path) };
  };
  if (c.avatar !== undefined) out.avatar = pic(c.avatar);
  if (c.banner !== undefined) out.banner = pic(c.banner);
  if (c.accent !== undefined) {
    if (c.accent !== null && !/^#[0-9a-f]{6}$/i.test(c.accent)) throw new Error('a colour like #5865f2');
    out.accent = c.accent;
  }
  return out;
}
