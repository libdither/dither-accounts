/**
 * `mail.contacts` for Gmail: what Gmail's own compose To field suggests while you type an address (docs/google.md,
 * "Suggesting people"). The To field asks Google's people-stack autocomplete, `POST https://peoplestack-pa.clients6.
 * google.com/$rpc/peoplestack.PeopleStackAutocompleteService/Autocomplete`, in JSON+protobuf (positional arrays), with
 * the page's cookies, a SAPISIDHASH made with mail.google.com, `X-Goog-AuthUser`, an API key from Gmail's page and
 * `X-User-Agent: grpc-web-javascript/0.1`. The hook makes that call from the Gmail page (`gmail.contacts`), checking the
 * body again; this side builds the body, reads the answer by its recorded layout (anything else is a 502, never people
 * read from the wrong place) and keeps a minute's cache.
 *
 * The request, as Gmail's page sends it (learned live 2026-11-14): `[134, query, [1, 2], 8]`, Google's own field names
 * from its 400s being affinity_type (134: Gmail's compose), the query, client_information, and the page size. The
 * answer: `[[suggestion, …], meta]` (an empty `[]` when nothing matches), a suggestion `[[[person], [token, …], …]]`, a
 * person `[profile, [address, null, [1]], null, null, ids, …]`, a profile `[[photo url, n], [display name, given name,
 * family name, n] | null, …]`.
 */
import type { MailContact } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';
import { LayoutChanged, readEach, RecordError, type Skipped, Skips } from '@dither-accounts/link/records';
import type { PageKind } from './mail.ts';
import { kindOf } from './protocol.ts';

/** Field 1 of the request, affinity_type: what Gmail's compose To field sends. */
export const AFFINITY_GMAIL_COMPOSE = 134;
/** Field 3, client_information, as the page sends it. */
export const CLIENT_INFORMATION = [1, 2] as const;
/** How many the To field asks for, and the most an app may. */
export const GMAIL_ASKS = 8;
export const MAX_CONTACTS = 20;
/** A longer query is refused (400) without asking Google. */
export const QUERY_MAX = 300;
/** Answers kept this long, per query and page size. */
export const CACHE_MS = 60_000;
const CACHE_MAX = 200;
/** A failure that says the call itself is broken (a layout, no key) makes `details.contacts` false this long. */
export const TROUBLE_MS = 15 * 60_000;

/** The request body: Gmail compose's own, for this query and page size. */
export const contactsRequest = (query: string, size: number): unknown[] => [AFFINITY_GMAIL_COMPOSE, query, [...CLIENT_INFORMATION], size];

/** The answer's own layout (not a list, no list of suggestions, no address anywhere): the whole answer is refused. */
export class ContactsLayoutError extends Error {
  constructor(
    readonly where: string,
    readonly expected: string,
    readonly got: string,
  ) {
    super(`at ${where}: expected ${expected}, got ${got}`);
  }
}

/** One suggestion's address, as Gmail writes them: something@something, no spaces. */
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;
/** What the skips of a suggestion are counted under (packages/link records.ts). */
export const CONTACTS_WHAT = 'gmail.contacts';

/**
 * The people a suggestions answer holds, in its own order, each address once (without regard to case). A suggestion
 * of more than one person (a group) or of one without an address (a phone number, say) is left out. A suggestion
 * whose person, address or name is not where the layout has it is left out too, named in `skipped` (where, never a
 * value) and counted in `skips` (readEach). The answer is refused (ContactsLayoutError) when its own layout is off,
 * and so is one in which no suggestion read has an address where one was expected; LayoutChanged (502) when most of
 * its suggestions fail.
 */
export function readContacts(json: unknown, skips?: Skips | null): { contacts: MailContact[]; groups: number; noAddress: number; skipped: Skipped[] } {
  const none = { contacts: [], groups: 0, noAddress: 0, skipped: [] };
  if (Array.isArray(json) && json.length === 0) return none;
  if (!Array.isArray(json)) throw new ContactsLayoutError('json', 'a list', kindOf(json));
  const list = json[0];
  if (list === null || list === undefined) return none;
  if (!Array.isArray(list)) throw new ContactsLayoutError('json[0]', 'the list of suggestions', kindOf(list));
  const out: MailContact[] = [];
  const seen = new Set<string>();
  let groups = 0;
  let noAddress = 0;
  const r = readEach(
    list,
    (s, i) => {
      const at = `json[0][${i}]`;
      if (!Array.isArray(s) || !Array.isArray(s[0])) throw new RecordError(`${at}[0]`, 'a suggestion', kindOf(Array.isArray(s) ? s[0] : s));
      const people = s[0][0];
      if (!Array.isArray(people) || !people.length) throw new RecordError(`${at}[0][0]`, "the suggestion's people", kindOf(people));
      // Every one of them is read (a group's too), so that an answer laid out otherwise cannot pass for groups.
      const read = people.map((p, j) => readPerson(p, `${at}[0][0][${j}]`));
      if (people.length > 1) {
        groups++;
        return undefined;
      }
      const p = read[0]!;
      if (!p.email) {
        noAddress++;
        return undefined;
      }
      const key = p.email.toLowerCase();
      if (seen.has(key)) return undefined;
      seen.add(key);
      out.push({ email: p.email, name: p.name && p.name.toLowerCase() !== key ? p.name : null });
      return undefined;
    },
    { what: CONTACTS_WHAT, skips },
  );
  const read = list.length - r.skipped.length;
  if (read && noAddress === read) throw new ContactsLayoutError('json[0][…][0][0][0][1]', 'an address on at least one suggestion', 'none');
  return { contacts: out, groups, noAddress, skipped: r.skipped };
}

/** One person of a suggestion: `[profile, [address, null, [1]] | null, …]`, its name at profile[1][0]. */
function readPerson(p: unknown, at: string): { email: string | null; name: string } {
  if (!Array.isArray(p)) throw new RecordError(at, 'a person', kindOf(p));
  const email = p[1];
  if (email !== null && email !== undefined && (!Array.isArray(email) || typeof email[0] !== 'string' || !ADDRESS.test(email[0]))) throw new RecordError(`${at}[1][0]`, 'an address', kindOf(Array.isArray(email) ? email[0] : email));
  const profile = p[0];
  if (profile !== null && profile !== undefined && !Array.isArray(profile)) throw new RecordError(`${at}[0]`, 'a profile or nothing', kindOf(profile));
  const names = Array.isArray(profile) ? profile[1] : null;
  if (names !== null && names !== undefined && !Array.isArray(names)) throw new RecordError(`${at}[0][1]`, 'a name or nothing', kindOf(names));
  const display = Array.isArray(names) ? names[0] : null;
  if (display !== null && display !== undefined && typeof display !== 'string') throw new RecordError(`${at}[0][1][0]`, 'a display name', kindOf(display));
  return { email: Array.isArray(email) ? (email[0] as string) : null, name: typeof display === 'string' ? display.replace(/\s+/g, ' ').trim() : '' };
}

/** What the hook answers for one call: Google's status and JSON, or why there is none. */
export interface ContactsAnswer {
  status: number;
  json?: unknown;
  /** 'timeout' (no answer in the hook's time), 'no-key' (no key of the page's was taken), 'not-json', 'network'. */
  error?: string;
  /** For an answer that is not JSON: what it reads as (a sign-in or verification page), never its text. */
  page?: PageKind | null;
  /** Google's gRPC status code, for a refusal. */
  code?: number | null;
}
export type ContactsTransport = (body: unknown[]) => Promise<ContactsAnswer>;
type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** The query an app sent, trimmed; and the number of people it wants, 1 to 20 (8 when it does not say). */
export function contactsInput(input: { query?: unknown; limit?: unknown }): { query: string; limit: number } {
  if (typeof input.query !== 'string') throw new StatusError('mail.contacts: query is text', 400);
  const query = input.query.trim();
  if (query.length > QUERY_MAX) throw new StatusError(`mail.contacts: a query is at most ${QUERY_MAX} characters`, 400);
  const l = input.limit;
  if (l !== undefined && l !== null && !Number.isInteger(l)) throw new StatusError('mail.contacts: limit is a whole number', 400);
  const limit = typeof l === 'number' ? Math.min(MAX_CONTACTS, Math.max(1, l)) : GMAIL_ASKS;
  return { query, limit };
}

/**
 * Suggestions through a transport (main.ts: the Gmail page's hook; tests: the fake), with a minute's cache. `ready`
 * says why the page cannot answer now (then 503 'unavailable', nothing asked), or null. Never logs a query or a person.
 */
export class GmailContacts {
  private cache = new Map<string, { at: number; contacts: MailContact[] }>();
  /** Why the last call failed in a way that will not mend by itself soon (a layout, no key), and when. */
  trouble: { at: number; why: string } | null = null;
  calls = 0;
  /** Suggestions left out of answers that were read (their own layout off), by kind: the status's `contactsSkipped`. */
  readonly skips: Skips;

  constructor(
    private transport: ContactsTransport,
    private opts: { log: Log; ready?: () => string | null; onChange?: () => void; now?: () => number } = { log: () => {} },
  ) {
    this.skips = new Skips({ log: (level, msg) => opts.log(level, msg), now: opts.now });
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Whether a failure of the call itself is recent: then `details.contacts` is false (and a call still tries). */
  troubled(): string | null {
    return this.trouble && this.now() - this.trouble.at < TROUBLE_MS ? this.trouble.why : null;
  }

  async suggest(input: { query?: unknown; limit?: unknown }): Promise<{ contacts: MailContact[] }> {
    const { query, limit } = contactsInput(input);
    if (!query) return { contacts: [] };
    // Ask for what the To field asks (8), or more when the app wants more: the top is Gmail's own either way.
    const size = Math.max(GMAIL_ASKS, limit);
    const key = `${size}\n${query.toLowerCase()}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return { contacts: hit.contacts.slice(0, limit) };
    const why = this.opts.ready?.() ?? null;
    if (why) throw new StatusError(why, 503, 'unavailable');
    this.calls++;
    const r = await this.transport(contactsRequest(query, size));
    let contacts: MailContact[];
    if (r.status === 200 && r.json !== undefined) {
      try {
        contacts = readContacts(r.json, this.skips).contacts;
      } catch (e) {
        const where = e instanceof ContactsLayoutError ? e.message : e instanceof LayoutChanged ? `${e.first.message}, and ${e.failed} of ${e.of} suggestions failed` : null;
        if (where === null) throw e;
        throw this.broken(`Gmail's people suggestions answer is not laid out as this extractor knows it (${where}); nothing was returned rather than possibly wrong people`);
      }
    } else throw this.failure(r);
    if (this.trouble) {
      this.trouble = null;
      this.opts.log('info', 'gmail contacts: answering again');
      this.opts.onChange?.();
    }
    for (const [k, v] of this.cache) if (now - v.at >= CACHE_MS) this.cache.delete(k);
    while (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: now, contacts });
    return { contacts: contacts.slice(0, limit) };
  }

  /** A failure of the call itself: 502, kept as the trouble (details.contacts false a while), logged once. */
  private broken(why: string): StatusError {
    const was = this.trouble?.why;
    this.trouble = { at: this.now(), why };
    if (was !== why) this.opts.log('warn', `gmail contacts: ${why}`);
    this.opts.onChange?.();
    return new StatusError(why, 502, undefined, { kind: 'bug' });
  }

  /** What an answer that is not suggestions says: the page or Google not able to now (503), late (504), or broken (502). */
  private failure(r: ContactsAnswer): StatusError {
    const code = typeof r.code === 'number' ? `, code ${r.code}` : '';
    if (r.error === 'timeout') return new StatusError("Google's people suggestions did not answer in time", 504);
    // A page that waits for the owner is the answer until they act, not the world failing for a moment.
    if (r.page === 'signin') return new StatusError("Google answered the people suggestions with a sign-in page; sign in in the live view", 503, 'unavailable', { kind: 'expected' });
    if (r.page === 'challenge') return new StatusError("Google answered the people suggestions with a verification page; open the live view", 503, 'unavailable', { kind: 'expected' });
    if (r.error === 'no-key') return this.broken(`no API key the Gmail page carries is taken by Google's people suggestions${r.status ? ` (the last answered ${r.status}${code})` : ''}`);
    if (r.status === 401) return new StatusError("Google's people suggestions say the Gmail page is not signed in (401)", 503, 'unavailable', { kind: 'expected' });
    if (r.status === 429 || r.status >= 500) return new StatusError(`Google's people suggestions are busy (${r.status}${code}); try again in a moment`, 503, 'unavailable', { kind: 'transient' });
    if (r.error === 'network' || r.status === 0) return new StatusError("the Gmail page could not reach Google's people suggestions", 503, 'unavailable', { kind: 'transient' });
    if (r.status === 200) return this.broken("Gmail's people suggestions answered with something that is not JSON");
    return this.broken(`Google refused the people suggestions (${r.status}${code})`);
  }
}
