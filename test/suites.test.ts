/** The page's grouping of Google accounts into identities (packages/manager/web/src/suites.ts). Invented accounts only. */
import { describe, expect, test } from 'bun:test';
import type { AccountInfo, AppInfo, StatusLayer } from '../packages/manager/src/api-types.ts';
import { appsUsing, emailOf, gives, groupIdentities, partStop, SUITES } from '../packages/manager/web/src/suites.ts';

const IFACES: Record<string, string[]> = { google: ['google.calendar', 'mail'], 'google-api': ['google.calendar'], gmessages: ['chat'], imap: ['mail'], discord: ['chat'] };
let n = 0;
function acct(kind: string, o: { email?: string; name?: string; layers?: StatusLayer[]; seen?: boolean } = {}): AccountInfo {
  n++;
  const who = o.email || o.name ? { name: o.name ?? o.email ?? null, detail: o.name && o.email ? o.email : null, avatar: null } : null;
  return {
    id: `acct-${n}`,
    kind,
    label: '',
    enabled: true,
    running: true,
    online: true,
    asleep: false,
    sleep: null,
    error: null,
    status: { status: 'online' },
    self: o.seen ? null : who,
    seenAs: who,
    liveView: kind === 'google',
    builtin: false,
    layers: o.layers ?? null,
    interfaces: IFACES[kind],
    dir: '/tmp/x',
    ownDir: true,
    createdBy: null,
    createdAt: n,
    settings: [],
  };
}
const google = SUITES.find((s) => s.id === 'google')!;
const part = (id: string) => google.parts.find((p) => p.id === id)!;

describe('Google identities', () => {
  test('ways in with one email are one identity, best way first; others stay as they were', () => {
    const api = acct('google-api', { email: 'alice@example.com' });
    const browser = acct('google', { email: 'Alice@Example.com', name: 'Ann Lee' });
    const imap = acct('imap', { email: 'alice@example.com' });
    const msgs = acct('gmessages', { name: '+1 555 0100', layers: [{ name: 'paired', state: 'ok', note: 'with a Google account (alice@example.com)' }] });
    const other = acct('imap', { email: 'bob@example.org' });
    const chat = acct('discord', { name: 'ann' });
    const { identities, rest } = groupIdentities([api, browser, imap, msgs, other, chat]);
    expect(identities.map((i) => i.key)).toEqual(['google:alice@example.com']);
    expect(identities[0].accounts.map((a) => a.kind)).toEqual(['google', 'google-api', 'gmessages', 'imap']);
    expect(rest.map((a) => a.id)).toEqual([other.id, chat.id]);
  });

  test('an IMAP Gmail address joins by its domain; an account with no email is an identity of its own', () => {
    const imap = acct('imap', { email: 'bob@gmail.com' });
    const unnamed = acct('google');
    const qr = acct('gmessages', { name: '+1 555 0101', layers: [{ name: 'paired', state: 'ok', note: 'by QR code' }] });
    const { identities, rest } = groupIdentities([unnamed, imap, qr]);
    expect(identities.map((i) => i.key)).toEqual(['google:bob@gmail.com', `google:#${unnamed.id}`, `google:#${qr.id}`]);
    expect(rest).toEqual([]);
  });

  test('the email comes from who it was last signed in as when it is stopped', () => {
    expect(emailOf(acct('google', { email: 'carol@example.com', seen: true }))).toBe('carol@example.com');
  });

  test('a part switched off in its layers is not given; a part stops only on its own layers and shared ones', () => {
    const off = acct('google', { email: 'dan@example.com', layers: [{ name: 'Gmail page', state: 'off', interface: 'mail' }] });
    expect(gives(off, part('gmail'))).toBe(false);
    expect(gives(off, part('calendar'))).toBe(true);
    const waiting = acct('google', {
      email: 'erin@example.com',
      layers: [
        { name: 'browser', state: 'ok' },
        { name: 'Gmail page', state: 'waiting', note: 'the Gmail page did not answer', interface: 'mail' },
      ],
    });
    expect(partStop(waiting, part('gmail'))?.name).toBe('Gmail page');
    expect(partStop(waiting, part('calendar'))).toBeNull();
  });

  test('apps using a part: grants on its interface that reach the account', () => {
    const a = acct('google', { email: 'fay@example.com' });
    const grant = (iface: string, accounts: '*' | string[], kinds: string[] | null = null) => ({ id: 'g', interface: iface, level: 'read' as const, accounts, kinds, dryRun: false, consent: [], createdAt: 0 });
    const app = (name: string, grants: ReturnType<typeof grant>[]): AppInfo => ({ id: name, name, describe: null, connected: true, lastSeen: null, grants, requests: [] });
    const apps = [app('cal', [grant('google.calendar', [a.id])]), app('mailer', [grant('mail', '*', ['imap'])]), app('all-mail', [grant('mail', '*')])];
    expect(appsUsing(apps, a, 'google.calendar').map((x) => x.name)).toEqual(['cal']);
    expect(appsUsing(apps, a, 'mail').map((x) => x.name)).toEqual(['all-mail']);
  });
});
