/**
 * What the page offers to add, as services you recognise rather than extractor kinds: each in a category, with its
 * mark, a line under its name, and the ways to add it when there is more than one (Google in a browser or through
 * your own OAuth client, Proton in a browser or through Proton Bridge, Telegram by QR code or Telegram Desktop). A way
 * is a kind plus the form values it fixes; mail providers are ways of `imap` with its `provider` set. A kind that can
 * be added but is not listed here still shows, under its manifest's name, in the category its interfaces say.
 *
 * And how an account is named: by a nickname when you gave it one, else by who it is signed in as (its username or
 * email), else by its kind. Its kind shows as its mark beside the name.
 */
import type { AccountInfo, AddField, KindInfo, ManagerState } from '../../src/api-types.ts';
import type { Brand, Glyph } from './icon-data.ts';

export type CategoryId = 'chat' | 'mail' | 'calendar' | 'money' | 'other';
export const CATEGORIES: { id: CategoryId; name: string; glyph: Glyph }[] = [
  { id: 'chat', name: 'Chat', glyph: 'chat' },
  { id: 'mail', name: 'Mail', glyph: 'mail' },
  { id: 'calendar', name: 'Calendars and contacts', glyph: 'calendar' },
  { id: 'money', name: 'Money', glyph: 'money' },
  { id: 'other', name: 'Other', glyph: 'grid' },
];

/** The category a kind's interfaces put it in: the first that matches, in the order above. */
export function categoryOf(interfaces: string[]): CategoryId {
  const has = (...names: string[]) => names.some((n) => interfaces.includes(n));
  if (has('chat')) return 'chat';
  if (has('mail')) return 'mail';
  if (has('calendar', 'contacts', 'google.calendar')) return 'calendar';
  if (has('statements', 'exchange', 'privacy.session', 'monero.view')) return 'money';
  return 'other';
}

export interface Mark {
  brand?: Brand;
  glyph?: Glyph;
}
const KIND_MARK: Record<string, Mark> = {
  discord: { brand: 'discord' },
  signal: { brand: 'signal' },
  whatsapp: { brand: 'whatsapp' },
  matrix: { brand: 'matrix' },
  telegram: { brand: 'telegram' },
  gmessages: { brand: 'gmessages' },
  x: { brand: 'x' },
  messenger: { brand: 'messenger' },
  instagram: { brand: 'instagram' },
  proton: { brand: 'proton' },
  imap: { glyph: 'mail' },
  google: { brand: 'google' },
  'google-api': { brand: 'google' },
  dav: { glyph: 'contacts' },
  ics: { glyph: 'link' },
  simplefin: { glyph: 'bank' },
  monero: { brand: 'monero' },
  privacy: { glyph: 'card' },
  schwab: { glyph: 'bank' },
  haveno: { glyph: 'exchange' },
  github: { brand: 'github' },
  bugwatch: { glyph: 'bell' },
  njalla: { glyph: 'server' },
  fake: { glyph: 'flask' },
  'chat-fake': { glyph: 'flask' },
};
/** An account's kind as a mark: its brand, else a glyph for what it is. */
export function markOf(kind: string, interfaces: string[] = []): Mark {
  return KIND_MARK[kind] ?? { glyph: CATEGORIES.find((c) => c.id === categoryOf(interfaces))!.glyph };
}

// ---------------------------------------------------------------- what can be added

export interface Way {
  id: string;
  label: string;
  glyph: Glyph;
  /** Said on hover: what this way does and what it needs. */
  tip: string;
  /** The kind it adds; or `oauth`, Google's provider sign-in with your own OAuth client. */
  kind?: string;
  oauth?: 'google';
  /** Form values this way fixes; their fields are not shown. */
  preset?: Record<string, string>;
  /** Fields this way leaves out. */
  hide?: string[];
  /** Optional fields this way needs, asked up front. */
  need?: string[];
  /** Offered only when the kind has this field (Telegram Desktop, when the manager has it switched on). */
  ifField?: string;
}
export interface Service {
  id: string;
  name: string;
  mark: Mark;
  category: CategoryId;
  /** One line under its name. */
  line: string;
  ways: Way[];
}

const BROWSER = (kind: string, where: string): Way => ({
  id: 'browser',
  label: 'Browser',
  glyph: 'browser',
  kind,
  tip: `Runs ${where} in a sandboxed browser on this machine; you sign in once in its live view.`,
});
/** imap's server fields: a provider preset fills them. */
const SERVER = ['imapHost', 'imapPort', 'imapSecurity', 'smtpHost', 'smtpPort', 'smtpSecurity'];
const MAILBOX = (provider: string, label: string, tip: string, glyph: Glyph = 'key'): Way => ({ id: provider, label, glyph, kind: 'imap', preset: { provider }, hide: SERVER, tip });

const SERVICES: Service[] = [
  // chat
  { id: 'discord', name: 'Discord', mark: { brand: 'discord' }, category: 'chat', line: 'Sign in once in a sandboxed browser', ways: [BROWSER('discord', 'the Discord web client')] },
  {
    id: 'signal',
    name: 'Signal',
    mark: { brand: 'signal' },
    category: 'chat',
    line: 'Link as a device: scan a code with your phone',
    ways: [{ id: 'link', label: 'QR code', glyph: 'qr', kind: 'signal', tip: 'Links this machine as another Signal device. On the phone: Signal → Settings → Linked devices.' }],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    mark: { brand: 'whatsapp' },
    category: 'chat',
    line: 'Link as a device: a QR code or a pairing code',
    ways: [{ id: 'link', label: 'QR code', glyph: 'qr', kind: 'whatsapp', tip: 'Links this machine like WhatsApp Web. Open WhatsApp on the phone every two weeks or the link lapses.' }],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    mark: { brand: 'telegram' },
    category: 'chat',
    line: 'Scan a code with your phone',
    ways: [
      {
        id: 'own',
        label: 'Your app',
        glyph: 'key',
        kind: 'telegram',
        preset: { signIn: 'qr', app: 'own' },
        need: ['apiId', 'apiHash'],
        tip: "By QR code, with an app of your own (my.telegram.org → API development tools), as Telegram's terms ask. On the phone: Telegram → Settings → Devices → Link Desktop Device.",
      },
      {
        id: 'borrowed',
        label: "Desktop's app",
        glyph: 'qr',
        kind: 'telegram',
        preset: { signIn: 'qr', app: 'desktop' },
        hide: ['apiId', 'apiHash'],
        tip: "By QR code, with Telegram Desktop's published app: no my.telegram.org step, but it is one client presenting another's app, which Telegram may hold against the account.",
      },
      {
        id: 'desktop',
        label: 'Telegram Desktop',
        glyph: 'desktop',
        kind: 'telegram',
        preset: { signIn: 'desktop' },
        hide: ['app', 'apiId', 'apiHash'],
        ifField: 'signIn',
        tip: "Runs Telegram Desktop in this account's sandbox: you sign in with Telegram's own screens in the live view.",
      },
    ],
  },
  {
    id: 'matrix',
    name: 'Matrix',
    mark: { brand: 'matrix' },
    category: 'chat',
    line: 'Your homeserver, with your password',
    ways: [{ id: 'password', label: 'Password', glyph: 'key', kind: 'matrix', tip: 'Signs in to your homeserver once and keeps only the session: no browser, no bridge.' }],
  },
  {
    id: 'gmessages',
    name: 'Google Messages',
    mark: { brand: 'gmessages' },
    category: 'chat',
    line: "Your phone's texts (SMS and RCS)",
    ways: [
      { id: 'qr', label: 'QR code', glyph: 'qr', kind: 'gmessages', hide: ['cookies'], tip: 'Pairs like messages.google.com. On the phone: Google Messages → your picture → Device pairing.' },
      { id: 'google', label: 'Google account', glyph: 'cookie', kind: 'gmessages', need: ['cookies'], tip: 'Pairs with your Google account: paste cookies from messages.google.com, then tap the matching emoji on the phone.' },
    ],
  },
  { id: 'x', name: 'X', mark: { brand: 'x' }, category: 'chat', line: 'Direct messages, signed in in a sandboxed browser', ways: [BROWSER('x', "X's web app")] },
  {
    id: 'messenger',
    name: 'Messenger',
    mark: { brand: 'messenger' },
    category: 'chat',
    line: 'Sign in once in a sandboxed browser',
    ways: [
      { ...BROWSER('messenger', 'messenger.com'), id: 'messenger', label: 'messenger.com', preset: { site: 'messenger' } },
      { ...BROWSER('messenger', 'facebook.com/messages'), id: 'facebook', label: 'facebook.com', preset: { site: 'facebook' } },
    ],
  },
  { id: 'instagram', name: 'Instagram', mark: { brand: 'instagram' }, category: 'chat', line: 'Direct messages, signed in in a sandboxed browser', ways: [BROWSER('instagram', 'instagram.com')] },

  // mail
  {
    id: 'proton',
    name: 'Proton Mail',
    mark: { brand: 'proton' },
    category: 'mail',
    line: 'In a sandboxed browser, or through Proton Bridge',
    ways: [
      { ...BROWSER('proton', 'Proton Mail'), tip: 'Runs Proton Mail in a sandboxed browser; sign in once in the live view, with "Keep me signed in". Works on free plans.' },
      { ...MAILBOX('proton', 'Proton Bridge', 'Over IMAP through Proton Bridge running on this machine (paid plans): give the password Bridge shows for this address.', 'bridge') },
    ],
  },
  { id: 'gmail', name: 'Gmail', mark: { brand: 'gmail' }, category: 'mail', line: 'Over IMAP, with an app password', ways: [MAILBOX('gmail', 'App password', 'Gmail over IMAP and SMTP with an app password (Google Account → Security → App passwords), not your account password.')] },
  { id: 'fastmail', name: 'Fastmail', mark: { glyph: 'mail' }, category: 'mail', line: 'Over IMAP, with an app password', ways: [MAILBOX('fastmail', 'App password', 'Fastmail over IMAP and SMTP with an app password (Settings → Privacy & Security → App passwords).')] },
  { id: 'icloud', name: 'iCloud Mail', mark: { brand: 'icloud' }, category: 'mail', line: 'Over IMAP, with an app-specific password', ways: [MAILBOX('icloud', 'App password', 'iCloud Mail over IMAP and SMTP with an app-specific password (account.apple.com → Sign-In and Security).')] },
  {
    id: 'imap',
    name: 'Other mail server',
    mark: { glyph: 'server' },
    category: 'mail',
    line: 'Any IMAP and SMTP server',
    ways: [{ id: 'custom', label: 'IMAP', glyph: 'server', kind: 'imap', preset: { provider: 'custom' }, need: ['imapHost', 'smtpHost'], tip: 'Your own server names, ports and security; the password is kept in its secret file here.' }],
  },

  // calendars and contacts
  {
    id: 'google',
    name: 'Google Calendar',
    mark: { brand: 'google' },
    category: 'calendar',
    line: 'In a sandboxed browser, or with your own OAuth client',
    ways: [
      { ...BROWSER('google', 'Google Calendar'), tip: 'Runs Google Calendar in a sandboxed browser; you sign in to Google once in the live view.' },
      { id: 'oauth', label: 'OAuth client', glyph: 'key', oauth: 'google', tip: "Google's API with an OAuth client of your own: no browser to keep running, but fewer kinds of data." },
    ],
  },
  {
    id: 'dav',
    name: 'CalDAV / CardDAV',
    mark: { glyph: 'contacts' },
    category: 'calendar',
    line: 'Nextcloud, Fastmail, iCloud, Radicale…',
    ways: [{ id: 'password', label: 'Password', glyph: 'key', kind: 'dav', tip: 'Finds your calendars and address books from the server name and keeps up every two minutes.' }],
  },
  {
    id: 'ics',
    name: 'Calendar link',
    mark: { glyph: 'link' },
    category: 'calendar',
    line: 'A read-only .ics or webcal:// feed',
    ways: [{ id: 'url', label: 'Link', glyph: 'link', kind: 'ics', tip: 'A published or secret-address calendar; checked every ten minutes. It cannot be written to.' }],
  },

  // money
  {
    id: 'simplefin',
    name: 'SimpleFIN Bridge',
    mark: { glyph: 'bank' },
    category: 'money',
    line: 'Banks and cards, read only',
    ways: [
      { id: 'token', label: 'Setup token', glyph: 'ticket', kind: 'simplefin', need: ['setupToken'], hide: ['accessUrl'], tip: 'A new token from bridge.simplefin.org → Apps → New connection; it works once.' },
      { id: 'url', label: 'Access URL', glyph: 'link', kind: 'simplefin', need: ['accessUrl'], hide: ['setupToken'], tip: 'An access URL already claimed.' },
    ],
  },
  { id: 'monero', name: 'Monero', mark: { brand: 'monero' }, category: 'money', line: 'A view-only wallet: sees, cannot spend', ways: [{ id: 'view', label: 'View key', glyph: 'key', kind: 'monero', tip: 'Your primary address and private view key; it scans against a remote node, which never sees the keys.' }] },
  { id: 'privacy', name: 'Privacy.com', mark: { glyph: 'card' }, category: 'money', line: 'Virtual cards, in a sandboxed browser', ways: [{ ...BROWSER('privacy', "Privacy.com's web app"), tip: "Runs Privacy.com in a sandboxed browser that keeps its own passkey; you sign in once and add the passkey in Privacy's settings." }] },
  { id: 'schwab', name: 'Charles Schwab', mark: { glyph: 'bank' }, category: 'money', line: 'Brokerage and bank exports, in a sandboxed browser', ways: [{ ...BROWSER('schwab', 'schwab.com'), tip: 'Runs schwab.com in a sandboxed browser; you sign in by hand (password and code) and it exports History and Realized Gain/Loss for an app such as dither-finance. Read only.' }] },
  { id: 'haveno', name: 'Haveno', mark: { glyph: 'exchange' }, category: 'money', line: 'A Haveno node on this machine', ways: [{ id: 'node', label: 'Node', glyph: 'server', kind: 'haveno', tip: "Leave everything empty for the node this machine's NixOS module runs." }] },

  // other
  { id: 'github', name: 'GitHub', mark: { brand: 'github' }, category: 'other', line: 'Notifications, with a classic token', ways: [{ id: 'token', label: 'Token', glyph: 'key', kind: 'github', tip: 'A classic personal access token with the notifications scope (fine-grained tokens cannot read notifications).' }] },
  { id: 'bugwatch', name: 'Bug watch', mark: { glyph: 'bell' }, category: 'other', line: "Your own services' errors, as notices and T3 threads", ways: [{ id: 'config', label: 'Config file', glyph: 'bell', kind: 'bugwatch', tip: 'Reads the error files and logs a JSON config names; each new bug is a notice, and a T3 coding thread looks into it (docs/bugwatch.md).' }] },
  { id: 'njalla', name: 'Njalla', mark: { glyph: 'server' }, category: 'other', line: 'DNS records of your domains, with an API token', ways: [{ id: 'token', label: 'API token', glyph: 'key', kind: 'njalla', tip: 'njal.la → Settings → API → Add token. You can restrict it to some domains there.' }] },
];

/** The services this manager can add now: ways whose kind it has (and may add), and kinds no service lists. */
export function services(s: ManagerState): Service[] {
  const addable = new Map(s.kinds.filter((k) => k.add).map((k) => [k.kind, k]));
  const ok = (w: Way) => (w.oauth ? !!s.providers[w.oauth] : !!w.kind && addable.has(w.kind) && (!w.ifField || !!addable.get(w.kind)!.add!.fields?.some((f) => f.key === w.ifField)));
  const out = SERVICES.map((sv) => ({ ...sv, ways: sv.ways.filter(ok) })).filter((sv) => sv.ways.length);
  const listed = new Set(SERVICES.flatMap((sv) => sv.ways.map((w) => w.kind)));
  for (const k of addable.values()) {
    if (listed.has(k.kind)) continue;
    const category = categoryOf(k.interfaces);
    out.push({ id: k.kind, name: k.name, mark: markOf(k.kind, k.interfaces), category, line: firstSentence(k.add!.blurb), ways: [{ id: 'add', label: 'Add', glyph: 'plus', kind: k.kind, tip: k.add!.blurb }] });
  }
  return out;
}

function firstSentence(t: string): string {
  const m = /^(.+?[.:;])(\s|$)/.exec(t);
  return (m ? m[1] : t).replace(/[.:;]$/, '');
}

/** A way's form: the fields it asks up front, those under "More options", and the values it fixes. */
export function formOf(kind: KindInfo | undefined, way: Way): { main: AddField[]; more: AddField[]; preset: Record<string, string> } {
  const fields = kind?.add?.fields ?? [];
  const preset = Object.fromEntries(Object.entries(way.preset ?? {}).filter(([k]) => fields.some((f) => f.key === k)));
  const shown = fields.filter((f) => !(f.key in preset) && !way.hide?.includes(f.key));
  const need = new Set(way.need ?? []);
  return {
    main: shown.filter((f) => !f.optional || need.has(f.key)).map((f) => (need.has(f.key) ? { ...f, optional: false } : f)),
    more: shown.filter((f) => f.optional && !need.has(f.key)),
    preset,
  };
}

/** `^(qr|desktop)$`: a field whose pattern is a short list of words is a choice, shown as buttons. */
export function choicesOf(f: AddField): string[] | null {
  const m = /^\^\(([\w-]+(?:\|[\w-]+){1,5})\)\$$/.exec(f.pattern ?? '');
  return m ? m[1].split('|') : null;
}

// ---------------------------------------------------------------- names

type Who = NonNullable<AccountInfo['self']>;
const same = (x: string | null | undefined, y: string) => !!x && x.replace(/^@/, '').toLowerCase() === y.replace(/^@/, '').toLowerCase();

/** Who it is (or was last) signed in as. */
export function whoOf(a: AccountInfo): Who | null {
  return a.self ?? a.seenAs ?? null;
}
/** The name you gave it, unless that is only its kind's name (what an account added without one is called) or who it is. */
export function nicknameOf(a: AccountInfo, kindName: string): string | null {
  const l = a.label.trim();
  if (!l || same(kindName, l) || same(a.kind, l)) return null;
  const w = whoOf(a);
  if (w && (same(w.name, l) || same(w.detail, l))) return null;
  return l;
}
/** Its username or email (the handle when it says one, else its name). */
export function usernameOf(a: AccountInfo): string | null {
  const w = whoOf(a);
  return w ? (w.detail ?? w.name) : null;
}
/** What the page calls it: its nickname, else who it is signed in as, else its kind. */
export function nameOf(a: AccountInfo, kindName: string): string {
  return nicknameOf(a, kindName) ?? usernameOf(a) ?? kindName;
}
/**
 * The line under its name: its kind, and who it is when the name is a nickname (or its display name, when that
 * differs from its username). Null when it is named by its kind already and there is nothing more to say.
 */
export function subtitleOf(a: AccountInfo, kindName: string): string | null {
  const nick = nicknameOf(a, kindName);
  const user = usernameOf(a);
  if (!nick && !user) return null;
  const w = whoOf(a);
  const extra = nick ? user : w?.detail && w.name && !same(w.name, w.detail) ? w.name : null;
  return extra ? `${kindName} · ${extra}` : kindName;
}
