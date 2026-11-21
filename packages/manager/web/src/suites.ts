/**
 * One sign-in, several services. A Google account is reached in several ways, each its own account here (its own
 * kind and extractor): a sandboxed browser (Calendar and Gmail), your own OAuth client (Calendar), Gmail over IMAP with
 * an app password, and Google Messages paired with your phone. The page shows those that are the same Google account
 * (the same email) as one identity, and says for each of its services which account gives it, how, and whether it
 * works. Nothing here changes what the manager keeps: grouping is the page's.
 */
import type { AccountInfo, AppInfo, StatusLayer } from '../../src/api-types.ts';
import type { Brand } from './icon-data.ts';

export interface SuitePart {
  id: string;
  name: string;
  /** The interface an account answers for it. */
  interface: string;
  /** The add sheet's service that adds it (catalog.ts). */
  service: string;
}
export interface Suite {
  id: string;
  name: string;
  brand: Brand;
  /** Kinds that are always one of its ways in, best first: the identity opens on the first it has. */
  kinds: string[];
  /** Kinds that join only by their email: an address of `domains`, or one an account of `kinds` already has. */
  byEmail: string[];
  domains: RegExp;
  parts: SuitePart[];
  /** Each kind's way in, in a word or two. */
  way: Record<string, string>;
}

export const SUITES: Suite[] = [
  {
    id: 'google',
    name: 'Google',
    brand: 'google',
    kinds: ['google', 'google-api', 'gmessages'],
    byEmail: ['imap'],
    domains: /@(gmail|googlemail)\.com$/i,
    parts: [
      { id: 'calendar', name: 'Calendar', interface: 'google.calendar', service: 'google' },
      { id: 'gmail', name: 'Gmail', interface: 'mail', service: 'gmail' },
      { id: 'messages', name: 'Messages', interface: 'chat', service: 'gmessages' },
    ],
    way: { google: 'Browser', 'google-api': 'OAuth client', imap: 'App password', gmessages: 'Paired phone' },
  },
];

export const suiteOfService = (service: string) => SUITES.find((su) => su.parts.some((p) => p.service === service)) ?? null;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/**
 * The email it is signed in as: from who it says it is, or, for Google Messages paired with a Google account, from
 * its `paired` layer ("with a Google account (address)"). Lower-cased; null when it has not said.
 */
export function emailOf(a: AccountInfo): string | null {
  const w = a.self ?? a.seenAs;
  for (const x of [w?.detail, w?.name]) if (x && EMAIL.test(x.trim())) return x.trim().toLowerCase();
  const note = a.layers?.find((l) => l.name === 'paired')?.note;
  const m = note ? /\(([^()\s]+@[^()\s]+\.[^()\s]+)\)/.exec(note) : null;
  return m ? m[1].toLowerCase() : null;
}

export interface Identity {
  suite: Suite;
  /** `google:alice@example.com`, or `google:#<account id>` for one whose email is not known yet. */
  key: string;
  email: string | null;
  /** Its accounts, best way in first. */
  accounts: AccountInfo[];
}

/** The accounts that are suites' identities, grouped, and the rest as they were. */
export function groupIdentities(accounts: AccountInfo[]): { identities: Identity[]; rest: AccountInfo[] } {
  const byKey = new Map<string, Identity>();
  const taken = new Set<string>();
  for (const su of SUITES) {
    const own = accounts.filter((a) => su.kinds.includes(a.kind));
    const known = new Set(own.map(emailOf).filter((e): e is string => !!e));
    const joining = accounts.filter((a) => {
      if (!su.byEmail.includes(a.kind)) return false;
      const e = emailOf(a);
      return !!e && (su.domains.test(e) || known.has(e));
    });
    const rank = (a: AccountInfo) => (su.kinds.includes(a.kind) ? su.kinds.indexOf(a.kind) : su.kinds.length - 0.5);
    for (const a of [...own, ...joining]) {
      const email = emailOf(a);
      const key = `${su.id}:${email ?? `#${a.id}`}`;
      const id = byKey.get(key) ?? byKey.set(key, { suite: su, key, email, accounts: [] }).get(key)!;
      id.accounts.push(a);
      taken.add(a.id);
    }
    for (const id of byKey.values()) id.accounts.sort((x, y) => rank(x) - rank(y) || x.createdAt - y.createdAt);
  }
  const identities = [...byKey.values()].sort((x, y) => (x.email && y.email ? x.email.localeCompare(y.email) : x.email ? -1 : y.email ? 1 : x.accounts[0].createdAt - y.accounts[0].createdAt));
  return { identities, rest: accounts.filter((a) => !taken.has(a.id)) };
}

/** The identity an account is part of, if any. */
export function identityOf(a: AccountInfo, accounts: AccountInfo[]): Identity | null {
  return groupIdentities(accounts).identities.find((i) => i.accounts.some((x) => x.id === a.id)) ?? null;
}

/** Whether it gives this part: its kind answers the interface, and its layers do not say it is switched off. */
export function gives(a: AccountInfo, part: SuitePart): boolean {
  return a.interfaces.includes(part.interface) && !a.layers?.some((l) => l.interface === part.interface && l.state === 'off');
}

/** Where this part stops on this account: the first of its layers (its own, and those all its parts rest on) waiting or failed. */
export function partStop(a: AccountInfo, part: SuitePart): StatusLayer | null {
  return a.layers?.find((l) => (!l.interface || l.interface === part.interface) && (l.state === 'waiting' || l.state === 'failed')) ?? null;
}

/** Apps holding a grant on this interface that reaches this account. */
export function appsUsing(apps: AppInfo[], a: AccountInfo, iface: string): AppInfo[] {
  return apps.filter((app) => app.grants.some((g) => g.interface === iface && (g.accounts === '*' ? !g.kinds || g.kinds.includes(a.kind) : g.accounts.includes(a.id))));
}
