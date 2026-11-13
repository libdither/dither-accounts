/**
 * Finding a user's calendars and address books from a server URL or just a domain (RFC 6764): the URL as given if it
 * has a path, /.well-known/caldav and /carddav, the _caldavs/_carddavs SRV records (and their TXT path), then the
 * root; the first that names a current-user-principal gives the principal, whose calendar-home-set and
 * addressbook-home-set are the homes. Contacts on another host (iCloud, Fastmail) are looked for there too.
 */
import { promises as dns } from 'node:dns';
import { StatusError } from '@dither-accounts/link';
import { AuthFailed, type DavClient, hasType, NS, propHrefs, propText, Unreachable } from './webdav.ts';

export interface Found {
  principal: string;
  calHome: string | null;
  cardHome: string | null;
  displayName: string | null;
  email: string | null;
}

/** https:// when no scheme is given; webcal-free. */
export function normalizeServer(input: string): URL {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new StatusError(`the server is an http(s) URL, not ${u.protocol}`, 400);
  u.hash = '';
  return u;
}

/** Providers whose contacts live on another host than their calendars. */
const SPLIT: { match: RegExp; cal: string; card: string }[] = [
  { match: /(^|\.)icloud\.com$|(^|\.)me\.com$/i, cal: 'https://caldav.icloud.com/', card: 'https://contacts.icloud.com/' },
  { match: /(^|\.)fastmail\.(com|fm)$|(^|\.)messagingengine\.com$/i, cal: 'https://caldav.fastmail.com/', card: 'https://carddav.fastmail.com/' },
];

const local = (host: string) => /^(localhost|[\d.]+|\[[\d:a-f]+\])$/i.test(host) || host.endsWith('.local') || !host.includes('.');

async function srv(service: 'caldav' | 'carddav', host: string): Promise<URL[]> {
  if (local(host)) return [];
  const out: URL[] = [];
  try {
    const recs = await dns.resolveSrv(`_${service}s._tcp.${host}`);
    let path = `/.well-known/${service}`;
    try {
      const txt = (await dns.resolveTxt(`_${service}s._tcp.${host}`)).flat().find((t) => t.startsWith('path='));
      if (txt) path = txt.slice(5);
    } catch {}
    for (const r of recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight)) if (r.name && r.name !== '.') out.push(new URL(`https://${r.name}:${r.port}${path}`));
  } catch {}
  return out;
}

export async function discover(client: DavClient, input: string, opts: { contactsServer?: string | null; log?: (m: string) => void } = {}): Promise<Found> {
  const start = normalizeServer(input);
  client.trust(start);
  const tried: string[] = [];
  let reached = false;
  let lastDown: Unreachable | null = null;

  const principalAt = async (u: URL): Promise<URL | null> => {
    try {
      const { responses, url } = await client.propfind(u, '<d:current-user-principal/><d:resourcetype/>', 0);
      reached = true;
      for (const r of responses) {
        const h = propHrefs(r, NS.d, 'current-user-principal', url)[0];
        if (h) return h;
      }
      for (const r of responses) if (hasType(r, NS.d, 'principal')) return new URL(r.href);
      tried.push(`${u.href} (no current-user-principal)`);
    } catch (e) {
      if (e instanceof AuthFailed) throw e;
      if (e instanceof Unreachable) lastDown = e;
      else {
        reached = true;
        tried.push(`${u.href} (${(e as Error).message})`);
      }
    }
    return null;
  };

  const candidates = async (service: 'caldav' | 'carddav', base: URL): Promise<URL[]> => {
    const list: URL[] = [];
    if (base.pathname !== '/' && base.pathname !== '') list.push(base);
    list.push(new URL(`/.well-known/${service}`, base));
    list.push(...(await srv(service, base.hostname)));
    list.push(new URL('/', base));
    const seen = new Set<string>();
    return list.filter((u) => !seen.has(u.href) && !!seen.add(u.href));
  };

  const homes = async (p: URL) => {
    const { responses, url } = await client.propfind(p, '<c:calendar-home-set/><card:addressbook-home-set/><d:displayname/><c:calendar-user-address-set/>', 0);
    const r = responses[0];
    if (!r) return { cal: null, card: null, name: null, email: null };
    const email = propHrefs(r, NS.c, 'calendar-user-address-set', url).find((h) => h.protocol === 'mailto:');
    return {
      cal: propHrefs(r, NS.c, 'calendar-home-set', url)[0]?.href ?? null,
      card: propHrefs(r, NS.card, 'addressbook-home-set', url)[0]?.href ?? null,
      name: propText(r, NS.d, 'displayname'),
      email: email ? decodeURIComponent(email.pathname) : null,
    };
  };

  const find = async (service: 'caldav' | 'carddav', base: URL) => {
    for (const c of await candidates(service, base)) {
      const p = await principalAt(c);
      if (p) {
        opts.log?.(`${service}: principal ${p.pathname} found from ${c.href}`);
        return { principal: p, ...(await homes(p)) };
      }
    }
    return null;
  };

  const split = SPLIT.find((s) => s.match.test(start.hostname));
  const first = (await find('caldav', split && start.pathname === '/' ? new URL(split.cal) : start)) ?? (await find('carddav', start));
  if (!first) {
    if (!reached && lastDown) throw lastDown;
    throw new StatusError(`found no CalDAV or CardDAV account at ${start.host}: tried ${tried.join('; ') || 'nothing answered'}`, 404);
  }
  const found: Found = { principal: first.principal.href, calHome: first.cal, cardHome: first.card, displayName: first.name, email: first.email };
  // Contacts (or calendars) on another host.
  const elsewhere = opts.contactsServer ? normalizeServer(opts.contactsServer) : split ? new URL(split.card) : null;
  if (!found.cardHome && elsewhere) {
    client.trust(elsewhere);
    try {
      const c = await find('carddav', elsewhere);
      if (c?.card) found.cardHome = c.card;
    } catch (e) {
      if (e instanceof AuthFailed) throw e;
      opts.log?.(`contacts server ${elsewhere.host}: ${(e as Error).message}`);
    }
  }
  if (!found.calHome && split) {
    const c = await find('caldav', new URL(split.cal)).catch(() => null);
    if (c?.cal) found.calHome = c.cal;
  }
  return found;
}
