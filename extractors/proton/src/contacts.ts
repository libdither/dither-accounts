/**
 * `mail.contacts` for Proton: what Proton's composer suggests while you type an address (docs/proton.md, "Suggesting
 * people"), from the addresses in your Proton contacts. As WebClients does it (read at a98022b, 2026-11-14):
 *
 * - the list is the store's contact emails (`contactEmails`, kept sorted by `Order`; packages/account/contactEmails);
 * - each is labelled as a recipient is written, `Name <Email>`, or the address alone when the name is the address
 *   (packages/shared/lib/mail/recipient.ts `recipientToInput`, `contactToInput`);
 * - ranked by `LastUsedTime`, most recent first, then by that label (packages/components/components/
 *   addressesAutocomplete/helper.tsx `getContactsAutocompleteItems`, `compare`);
 * - kept when the label holds what was typed, without regard to case, spaces around it or accents (packages/components/
 *   components/autocomplete/useAutocomplete.ts `useAutocompleteFilter`, packages/shared/lib/helpers/string.ts
 *   `normalize`), from the first character on, at most 20 (AddressesAutocomplete's `limit`).
 *
 * Contact groups, which the composer also offers, are left out. When the store has no list (not loaded yet), the same
 * list comes from `contacts/v4/contacts/emails`, a page of 1000 at a time, as the store fills itself.
 */
import type { MailContact } from '@dither-accounts/interfaces';
import { StatusError } from '@dither-accounts/link';

/** A contact email as the store and the API keep it: only what the composer's suggestions use. */
export interface ProtonContactEmail {
  Email: string;
  Name: string;
  LastUsedTime: number;
  Order: number;
}

export const PROTON_LIMIT = 20;
export const DEFAULT_LIMIT = 8;
export const QUERY_MAX = 300;

/** recipientToInput({ Name, Address: Email }): `Name <Email>`, the address alone, or `Name Email`. */
export function protonLabel(c: { Name: string; Email: string }): string {
  if (c.Email && c.Name && c.Email !== c.Name) return `${c.Name} <${c.Email}>`;
  if (c.Email === c.Name) return c.Email || '';
  return `${c.Name} ${c.Email}`;
}

/** normalize(value, true): lower case, trimmed, accents taken off. */
export const normalize = (v: string) =>
  v
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * The list as the store has it, from whatever the page or the API gave: entries without an address are left out, a
 * missing name is '' and a missing time 0; sorted by Order (stable). Null when not one entry is a contact email.
 */
export function contactEmailsOf(raw: unknown): ProtonContactEmail[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ProtonContactEmail[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const x = c as Record<string, unknown>;
    if (typeof x.Email !== 'string' || !x.Email) continue;
    out.push({ Email: x.Email, Name: typeof x.Name === 'string' ? x.Name : '', LastUsedTime: typeof x.LastUsedTime === 'number' && Number.isFinite(x.LastUsedTime) ? x.LastUsedTime : 0, Order: typeof x.Order === 'number' && Number.isFinite(x.Order) ? x.Order : 0 });
  }
  if (raw.length && !out.length) return null;
  return out.sort((a, b) => a.Order - b.Order);
}

/** The composer's suggestions for a query (trimmed, not empty), at most `limit`, each address once. */
export function suggestFrom(list: ProtonContactEmail[], query: string, limit: number): MailContact[] {
  const want = normalize(query);
  if (!want) return [];
  const items = list.map((c) => ({ c, label: protonLabel(c), score: c.LastUsedTime || 0 }));
  // compare(): the score, most recent first; then the label, as JavaScript compares strings.
  items.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.label > b.label ? 1 : a.label < b.label ? -1 : 0));
  const out: MailContact[] = [];
  const seen = new Set<string>();
  // The composer stops at 20 matches; the same address twice (two contacts) counts there, and is shown once here.
  let matched = 0;
  for (const { c, label } of items) {
    if (matched >= PROTON_LIMIT || out.length >= limit) break;
    if (!normalize(label).includes(want)) continue;
    matched++;
    const key = c.Email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = c.Name.replace(/\s+/g, ' ').trim();
    out.push({ email: c.Email, name: name && name.toLowerCase() !== key ? name : null });
  }
  return out;
}

/** The query an app sent, trimmed; the number it wants, 1 to 20 (8 when it does not say). */
export function contactsInput(input: { query?: unknown; limit?: unknown }): { query: string; limit: number } {
  if (typeof input.query !== 'string') throw new StatusError('mail.contacts: query is text', 400);
  const query = input.query.trim();
  if (query.length > QUERY_MAX) throw new StatusError(`mail.contacts: a query is at most ${QUERY_MAX} characters`, 400);
  const l = input.limit;
  if (l !== undefined && l !== null && !Number.isInteger(l)) throw new StatusError('mail.contacts: limit is a whole number', 400);
  return { query, limit: typeof l === 'number' ? Math.min(PROTON_LIMIT, Math.max(1, l)) : DEFAULT_LIMIT };
}

/** Where the list comes from: the page's store (null when it has none yet), and the API's pages. */
export interface ContactsSource {
  store(): Promise<unknown[] | null>;
  page(page: number, size: number): Promise<{ ContactEmails?: unknown; Total?: unknown }>;
}

/** The list is read again after this; within it, keystrokes are matched here without asking the page. */
export const LIST_MS = 30_000;
const PAGE = 1000;
const PAGES = 50;

/** Suggestions from a list kept for LIST_MS: the store's, else the API's. Never logs a query or a person. */
export class ProtonContacts {
  private list: { at: number; from: 'store' | 'api'; emails: ProtonContactEmail[] } | null = null;
  private loading: Promise<ProtonContactEmail[]> | null = null;

  constructor(
    private source: ContactsSource,
    private opts: { ready?: () => string | null; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Where the list last came from, and how many (for the status). */
  get from(): string | null {
    return this.list ? `${this.list.from}, ${this.list.emails.length}` : null;
  }

  async suggest(input: { query?: unknown; limit?: unknown }): Promise<{ contacts: MailContact[] }> {
    const { query, limit } = contactsInput(input);
    if (!query) return { contacts: [] };
    return { contacts: suggestFrom(await this.emails(), query, limit) };
  }

  private async emails(): Promise<ProtonContactEmail[]> {
    if (this.list && this.now() - this.list.at < LIST_MS) return this.list.emails;
    const why = this.opts.ready?.() ?? null;
    if (why) throw new StatusError(why, 503, 'unavailable');
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(): Promise<ProtonContactEmail[]> {
    const raw = await this.source.store();
    let from: 'store' | 'api' = 'store';
    let emails = raw === null ? null : contactEmailsOf(raw);
    if (raw !== null && emails === null) throw new StatusError("Proton's contact emails in the page are not laid out as this extractor knows them; nothing was returned rather than possibly wrong people", 502);
    if (emails === null) {
      from = 'api';
      const all: unknown[] = [];
      for (let p = 0; p < PAGES; p++) {
        const r = await this.source.page(p, PAGE);
        if (!Array.isArray(r?.ContactEmails)) throw new StatusError("Proton's contact emails (contacts/v4/contacts/emails) answered in a layout this extractor does not know", 502);
        all.push(...r.ContactEmails);
        const total = typeof r.Total === 'number' ? r.Total : null;
        if (r.ContactEmails.length < PAGE || (total !== null && all.length >= total)) break;
      }
      emails = contactEmailsOf(all);
      if (emails === null) throw new StatusError("Proton's contact emails (contacts/v4/contacts/emails) answered in a layout this extractor does not know", 502);
    }
    this.list = { at: this.now(), from, emails };
    return emails;
  }
}
