/**
 * The hub's network search (dither-chat's netsearch.ts) in Telegram's terms. The hub asks once per account
 * (scope "all"), sometimes narrowed to some chats (`in`):
 *
 * - words alone, anywhere: messages.searchGlobal, every chat the account is in, channels too;
 * - in some chats, or by someone (from:), or mentioning you: messages.search, one chat at a time, or with no chat
 *   named over every private chat and basic group at once (inputPeerEmpty), which is the most Telegram offers for a
 *   person's messages; with words, a global search filtered to that person adds the supergroups and channels;
 * - has: as one of Telegram's message filters (photos, videos, voice, files, links).
 *
 * Telegram has no mention search but your own mentions, no sticker or reaction filter, and pages newest first.
 */
import type * as P from '@dither-chat/protocol';
import type { tl } from './backend.ts';

export type SearchCommand = Extract<P.AdapterCommand, { t: 'search' }>;

/** Hits per search, as the hub asks (25), and at most Telegram's page. */
export const SEARCH_PAGE = 25;
/** Requests one search may make: chats named × people named. */
export const SEARCH_REQUESTS = 8;

const FILTERS: Record<string, tl.TypeMessagesFilter['_'] | null> = {
  image: 'inputMessagesFilterPhotos',
  video: 'inputMessagesFilterVideo',
  audio: 'inputMessagesFilterVoice',
  file: 'inputMessagesFilterDocument',
  attachment: 'inputMessagesFilterDocument',
  link: 'inputMessagesFilterUrl',
  embed: 'inputMessagesFilterUrl',
  sticker: null,
  reaction: null,
};

/** has: as one Telegram filter. Throws, in words, for what Telegram cannot filter by. */
export function searchFilter(has: readonly string[] | undefined, mentionsMe: boolean): tl.TypeMessagesFilter {
  const kinds = [...new Set(has ?? [])];
  const cannot = kinds.filter((h) => !FILTERS[h]);
  if (cannot.length) throw new Error(`Telegram cannot search for has:${cannot.join(', has:')}`);
  let names = [...new Set(kinds.map((h) => FILTERS[h]!))];
  if (names.includes('inputMessagesFilterPhotos') && names.includes('inputMessagesFilterVideo')) names = [...names.filter((n) => n !== 'inputMessagesFilterPhotos' && n !== 'inputMessagesFilterVideo'), 'inputMessagesFilterPhotoVideo'];
  if (mentionsMe) names.push('inputMessagesFilterMyMentions');
  if (names.length > 1) throw new Error('Telegram searches one kind at a time: one has: (or mentions of you) per search');
  return { _: names[0] ?? 'inputMessagesFilterEmpty' } as tl.TypeMessagesFilter;
}

/** The words as Telegram takes them: quotes are not its syntax, so they go. */
export const searchWords = (text: string) => text.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Telegram's date bounds, in seconds, a second wider than asked each way: whether its bounds include their ends is
 * not written down, so the hits are held to the hub's (after inclusive, before exclusive) by `inDates`.
 */
export function searchDates(q: P.NetworkQuery): { minDate: number; maxDate: number } {
  return { minDate: q.after != null ? Math.max(0, Math.floor(q.after / 1000) - 1) : 0, maxDate: q.before != null ? Math.ceil(q.before / 1000) + 1 : 0 };
}

export const inDates = (q: P.NetworkQuery, ts: number) => (q.after == null || ts >= q.after) && (q.before == null || ts < q.before);
