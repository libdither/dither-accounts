/**
 * @ mentions (docs/mentions.md). The composer's @ picker asks the hub who this conversation can ping; the hub asks
 * an adapter with capability 'mentionables' for the people the network knows here but the hub does not store
 * (Discord server channels, Matrix rooms in a space, Telegram supergroups). Nothing in an answer is stored.
 */

/** One account the network would notify if named in this conversation. */
export interface MentionablePerson {
  /** Native identity id, as `<@nativeId>` in a body. */
  nativeId: string;
  name: string;
  handle?: string;
  avatar?: string;
  isBot?: boolean;
  /** ms of their last message in this conversation, when the adapter knows it. */
  lastSpoke?: number;
}

/** A role that may be pinged here (Discord: a mentionable role, or any role while you have Mention Everyone). */
export interface MentionableRole {
  id: string;
  name: string;
  /** #RRGGBB */
  color?: string;
  count?: number;
}

/** The answer to the adapter command `mentionables`. */
export interface Mentionables {
  /** Best first, at most the command's limit. */
  people: MentionablePerson[];
  roles?: MentionableRole[];
  /** You may write @everyone and @here here (Discord: Mention Everyone; Matrix: the power level for @room). */
  everyone?: boolean;
}

/** Which people the picker offers in a conversation (the place pref `mentionScope`, docs/mentions.md). */
export type MentionScope = 'here' | 'friends' | 'everyone';

/** One row of the composer's @ picker, worked out by the hub. */
export interface MentionRow {
  kind: 'identity' | 'person' | 'role' | 'everyone' | 'here';
  /** What the composer inserts in place of the typed @query, a trailing space included. */
  insert: string;
  /** The network notifies them; false: the others see plain @Name. */
  pings: boolean;
  section: 'here' | 'friends' | 'everyone';
  name: string;
  handle?: string;
  avatar?: string;
  network?: string;
  identityId?: string;
  personId?: string;
  roleId?: string;
  color?: string;
  isBot?: boolean;
  /** A person with accounts on several networks: one row per account (the picker opens them with →). */
  accounts?: MentionRow[];
}

/** GET /api/conversations/:id/mentionables?q=&scope=&only= */
export interface MentionablesView {
  rows: MentionRow[];
  /** The network was not asked or did not answer in time: the rows are what the hub knows. */
  partial?: boolean;
}
