/**
 * `contacts`: address books and the people in them, the same to an app whether CardDAV or a provider's own API is
 * behind it. Ids are the extractor's own; `uid` is the vCard UID. Keeping up, sync tokens, 410, 412 and 403 work as in
 * `calendar`.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface AddressBook {
  id: string;
  name: string;
  description: string | null;
  readOnly: boolean;
}

export interface ContactValue {
  value: string;
  /** home, work, cell… as the card says; null when it does not. */
  type: string | null;
}

export interface Contact {
  id: string;
  bookId: string;
  uid: string;
  name: { full: string | null; given: string | null; family: string | null };
  nickname: string | null;
  emails: ContactValue[];
  phones: ContactValue[];
  /** One line each, as it would be written on an envelope. */
  addresses: ContactValue[];
  org: string | null;
  title: string | null;
  /** YYYY-MM-DD, or --MM-DD without a year. */
  birthday: string | null;
  urls: string[];
  note: string | null;
  /** A URL, or a data: URI for a photo kept in the card. */
  photo: string | null;
  updated: number | null;
  etag: string | null;
  /** The vCard as the server has it, for anything the fields leave out. */
  vcard: string | null;
}

/** A new or changed contact: the fields, or `vcard`, used as it is. */
export type ContactInput = Partial<Omit<Contact, 'id' | 'bookId' | 'etag' | 'updated' | 'vcard'>> & { vcard?: string };

export const contacts = iface({
  name: 'contacts',
  version: 1,
  describe: 'Your address books and the people in them.',
  levels: {
    read: 'See your contacts',
    write: 'Add, change and delete your contacts',
  },
  ops: {
    'contacts.books': op('read', 'Your address books', s.object({}), s.typed<{ books: AddressBook[] }>(), 60_000),
    'contacts.list': op(
      'read',
      "An address book's contacts, a page at a time",
      s.object({ bookId: s.string, pageToken: s.optional(s.string) }),
      s.typed<{ contacts: Contact[]; next: string | null; syncToken: string | null }>(),
      120_000,
    ),
    'contacts.changes': op(
      'read',
      'What changed in an address book since a sync token',
      s.object({ bookId: s.string, syncToken: s.string }),
      s.typed<{ changed: Contact[]; removed: string[]; syncToken: string; more: boolean }>(),
      120_000,
    ),
    'contacts.put': op(
      'write',
      'Add a contact (no id) or change one',
      s.object({ bookId: s.string, id: s.optional(s.string), contact: s.typed<ContactInput>('a contact'), ifMatch: s.optional(s.string) }),
      s.typed<Contact>(),
      60_000,
    ),
    'contacts.delete': op('write', 'Delete a contact', s.object({ bookId: s.string, id: s.string, ifMatch: s.optional(s.string) }), s.object({}), 60_000),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'contacts.changed': ev('Something changed in an address book: call contacts.changes with your last sync token', s.typed<{ bookId: string }>()),
  },
});
