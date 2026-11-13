/**
 * The account's own self on its network (docs/account-self.md): what the network says needs doing before it carries
 * on (notices), its presence and status as others see them, its settings as the network keeps them (folders, privacy),
 * where it is signed in, and ignoring someone. Blocking is the `block` command and your note on someone the
 * `contactNotes` capability (adapter.ts), shared with Signal; your profile's fields are setProfile's (PersonAbout.editable).
 *
 * All of it is additive to the adapter protocol (adapter.ts takes these unions in): an adapter that says nothing of it
 * is an older one, and the hub and page offer each part only where the account's capabilities name it.
 */

import type { Network } from './ontology.ts';

export type SelfCapability =
  /**
   * Ignores someone or stops ignoring them (the `ignore` command): their messages stay but are kept out of the way
   * (Discord's Ignore). The account's list of whom it ignores comes as `ignored` events.
   */
  | 'ignore'
  /** Sets your own presence and status line (the `setPresence` command); `selfState` events say them. */
  | 'setPresence'
  /** Lists where the account is signed in (the `sessions` command), asked when the owner opens that list. */
  | 'sessions';

/**
 * Something the network wants the owner to do on the account, as it says it: verify a phone or email, agree to new
 * terms, a strike or limit on the account, an age check. The adapter only passes it on; it never does it, and the hub
 * never dismisses it: it goes when the network stops saying it (the next `notices` without it).
 */
export interface AccountNotice {
  /** Stable while the network says the same thing: 'required:REQUIRE_VERIFIED_PHONE', 'standing'. */
  key: string;
  kind: 'verify' | 'agreements' | 'standing' | 'age' | 'other';
  /** A few words: "Verify your phone number". */
  title: string;
  /** A plain sentence of what it means and where to do it. */
  message: string;
  /** The account's live view is where to do it. */
  liveView?: boolean;
  /** ms epoch, when the network said it first, where it says. */
  since?: number;
}

export type OwnPresenceState = 'online' | 'idle' | 'dnd' | 'invisible';

/** Your own status line. Absent fields: none. */
export interface OwnStatus {
  text?: string;
  /** A Unicode emoji, or a custom one as `:name:` (it shows by name). */
  emoji?: string;
  /** ms epoch it clears itself at. */
  expiresAt?: number;
}

export interface OwnPresence {
  state: OwnPresenceState;
  /** ms epoch the state goes back to online by itself (Discord's "for 1 hour"). */
  until?: number;
  status?: OwnStatus;
}

/** A folder of spaces as the network keeps your arrangement (Discord's server folders). */
export interface NetworkFolder {
  id?: string;
  name?: string;
  /** CSS colour. */
  color?: string;
  /** Native space ids, in the network's order. A lone space outside any folder is a folder of one without a name. */
  spaces: string[];
}

/** A setting as a line to show: "Direct messages from server members": "Allowed, except in 2 servers". */
export interface SelfFact {
  label: string;
  value: string;
}

/**
 * The account's own state as the network keeps it. Each part an event carries replaces what the hub has of it; a part
 * left out keeps what it has.
 */
export interface SelfState {
  presence?: OwnPresence;
  /** Every folder and lone space, in the network's order. */
  folders?: NetworkFolder[];
  /** Privacy settings worth knowing, as words. */
  privacy?: SelfFact[];
}

/** One place the account is signed in. */
export interface AccountSession {
  /** The network's id for it (Discord's id_hash). */
  id: string;
  /** The session dither runs (its sandbox). */
  current?: boolean;
  /** "Chrome", "Discord Android". */
  client?: string;
  os?: string;
  /** Rough place, as the network guesses it. */
  location?: string;
  /** ms epoch. */
  lastUsed?: number;
}

/** The `sessions` command's reply. */
export interface SessionsResult {
  sessions: AccountSession[];
}

/** What `setPresence` changes. A field left out stays as it is; `status: null` clears the status line. */
export interface PresenceChange {
  state?: OwnPresenceState;
  status?: OwnStatus | null;
}

/** The adapter's events of these. */
export type SelfEvent =
  /** Everything the network wants done on the account now: the whole list, an empty one when nothing. */
  | { t: 'notices'; notices: AccountNotice[] }
  | { t: 'selfState'; state: SelfState }
  /** Everyone the account ignores (capability 'ignore'): the whole list, after connect and on each change. */
  | { t: 'ignored'; identities: string[] };

/** The hub's commands of these. */
export type SelfCommand =
  /** Ignore them, or (ignored: false) stop (capability 'ignore'). reply.result: { ignored: boolean }; an `ignored` event follows. */
  | { t: 'ignore'; id: string; identity: string; ignored: boolean }
  /** Your presence and status (capability 'setPresence'). reply.result: OwnPresence as it now stands. */
  | { t: 'setPresence'; id: string; change: PresenceChange }
  /** Where the account is signed in (capability 'sessions'). reply.result: SessionsResult. */
  | { t: 'sessions'; id: string };

/** The networks' limits on these, in characters as bioLength counts them (about.ts). */
export const SELF_LIMITS: Partial<Record<Network, { note?: number; statusText?: number; name?: number; pronouns?: number; avatarBytes?: number }>> = {
  discord: { note: 256, statusText: 128, name: 32, pronouns: 40, avatarBytes: 10 * 1024 * 1024 },
};

export const PRESENCE_LABEL: Record<OwnPresenceState, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
};

export const OWN_PRESENCE_STATES: readonly OwnPresenceState[] = ['online', 'idle', 'dnd', 'invisible'];

// ------------------------------------------------------------------ hub views

/** An account's own state as the hub has it (AccountView.self). */
export interface AccountSelfView {
  /** What the network wants done, oldest first. */
  notices: (AccountNotice & { since: number })[];
  presence?: OwnPresence;
  /** The network's folders in hub ids; `spaces` leaves out spaces the hub does not have. */
  folders?: { name: string | null; color?: string; spaces: string[] }[];
  /** When the owner last brought the network's folders into dither's sidebar (POST /api/self/:account/folders/import). */
  foldersImportedAt?: number;
  privacy?: SelfFact[];
  /** The owner's opt-in: Do not disturb on this network during quiet hours. Off unless set. */
  dndQuietHours?: boolean;
}

/** POST /api/self/:account/folders/import */
export interface FolderImportResult {
  /** Dither folders made. */
  made: { id: string; name: string; spaces: number }[];
  /** Network folders not made: their spaces are all in a dither folder already, or the hub has none of them. */
  skipped: { name: string | null; why: string }[];
}
