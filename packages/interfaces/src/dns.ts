/**
 * `dns`: a DNS host's zones and their records (docs/njalla.md). Read lists them; write adds, changes and removes
 * records. Nothing here registers, renews or transfers a domain, changes its name servers, or makes API tokens.
 *
 * Names are relative to the zone, as DNS hosts' panels show them: `@` is the zone itself, `www` is www.<zone>. A full
 * name (www.example.com, or with its final dot) is taken too and made relative. Types are upper case (A, AAAA, CNAME,
 * MX, TXT, CAA, SRV…). A TTL is in seconds; the host may round it to the values it allows.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface DnsZone {
  /** The domain, example.com */
  name: string;
  /** The host's word for it (active, expired…), when it says. */
  status: string | null;
  /** When the registration runs out (ISO 8601), when the host says. */
  expiry: string | null;
}

export interface DnsRecord {
  /** The host's id for it: what dns.edit and dns.remove take. */
  id: string;
  /** Relative to the zone: `@`, `www`, `_acme-challenge.tn`. */
  name: string;
  type: string;
  content: string;
  /** Seconds. */
  ttl: number | null;
  /** MX and SRV priority. */
  prio?: number | null;
}

const record = {
  zone: s.string,
  name: s.string,
  type: s.string,
  content: s.string,
  ttl: s.optional(s.integer),
  prio: s.optional(s.integer),
};

export const dns = iface({
  name: 'dns',
  version: 1,
  describe: 'The DNS records of your domains.',
  levels: {
    read: 'See your domains and their DNS records',
    write: "Add, change and remove your domains' DNS records",
  },
  ops: {
    'dns.zones': op('read', 'Your domains (the ones the account may touch)', s.object({}), s.typed<{ zones: DnsZone[] }>()),
    'dns.records': op('read', "A domain's records", s.object({ zone: s.string }), s.typed<{ records: DnsRecord[] }>()),
    'dns.add': op('write', 'Add a record (another record of the same name and type may already be there: both stay)', s.object(record), s.typed<{ record: DnsRecord }>()),
    'dns.edit': op(
      'write',
      "Change a record's content, TTL or priority (not its name or type: remove it and add another)",
      s.object({ zone: s.string, id: s.string, content: s.optional(s.string), ttl: s.optional(s.integer), prio: s.optional(s.integer) }),
      s.typed<{ record: DnsRecord }>(),
    ),
    'dns.remove': op('write', 'Remove a record', s.object({ zone: s.string, id: s.string }), s.object({})),
    'dns.set': op(
      'write',
      'Make one name and type hold exactly this record: unchanged when it already does, else one there is changed (or one added) and the rest of that name and type removed',
      s.object(record),
      s.typed<{ record: DnsRecord; changed: boolean; removed: string[] }>(),
    ),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
    'dns.changed': ev("A domain's records were changed through this account", s.typed<{ zone: string }>()),
  },
});
