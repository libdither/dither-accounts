/**
 * Signing in with another account here (docs/signin-relay.md), the parts that need no browser: reading a sign-in link
 * (spec/signin.ts) and the manager's checks on each relay (manager/src/signin.ts), against an in-memory registry.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { isAnswer, onlyIdentity, readAuthorize, scopeWords } from '@dither-accounts/spec/signin';
import { Store } from '../packages/manager/src/db.ts';
import { type Kind, kindOf } from '../packages/manager/src/kinds.ts';
import { SignInRelays } from '../packages/manager/src/signin.ts';

const link = (q: Record<string, string>, base = 'https://accounts.google.com/o/oauth2/v2/auth') => `${base}?${new URLSearchParams(q)}`;
const LUMA = { response_type: 'code', client_id: 'luma-web.apps.example.com', redirect_uri: 'https://luma.com/google', state: 'st', scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile' };

test('a redirect-flow link is read: its provider, where the answer goes, and what it asks for', () => {
  expect(readAuthorize(link(LUMA))).toEqual({ provider: 'google', redirect: 'https://luma.com/google', site: 'https://luma.com', scopes: LUMA.scope.split(' ') });
  expect(readAuthorize(link(LUMA, 'https://accounts.google.com/o/oauth2/auth'))).toMatchObject({ provider: 'google' });
  expect(scopeWords('google', LUMA.scope.split(' '))).toEqual(['your email address', 'your name and picture']);
  expect(onlyIdentity('google', LUMA.scope.split(' '))).toBe(true);
  expect(onlyIdentity('google', ['email', 'https://www.googleapis.com/auth/contacts.readonly'])).toBe(false);
});

test('links that are not relayed say why', () => {
  const no = (url: string) => (readAuthorize(url) as { error?: string }).error;
  expect(no('https://accounts.google.com/signin/v2/identifier')).toContain('not a sign-in');
  expect(no('https://evil.example.com/o/oauth2/v2/auth?response_type=code&redirect_uri=https://luma.com/google')).toContain('not a sign-in');
  expect(no(link({ ...LUMA, response_type: 'token' }))).toContain('code');
  expect(no(link({ ...LUMA, response_mode: 'form_post' }))).toContain('form_post');
  expect(no(link({ ...LUMA, redirect_uri: 'http://luma.com/google' }))).toContain('https');
  expect(no(link({ ...LUMA, redirect_uri: 'http://127.0.0.1:9/google' }))).toContain('https');
  expect(readAuthorize(link({ ...LUMA, redirect_uri: 'http://127.0.0.1:9/google' }), { allowLoopback: true })).toMatchObject({ site: 'http://127.0.0.1:9' });
  const { redirect_uri: _r, ...none } = LUMA;
  expect(no(link(none))).toContain('redirect_uri');
});

test("an answer is the redirect address with a code or the provider's error, and nothing else", () => {
  expect(isAnswer('https://luma.com/google?code=4%2Fabc&state=st', 'https://luma.com/google')).toBe(true);
  expect(isAnswer('https://luma.com/google?error=access_denied', 'https://luma.com/google')).toBe(true);
  expect(isAnswer('https://luma.com/google', 'https://luma.com/google')).toBe(false);
  expect(isAnswer('https://luma.com/googlex?code=1', 'https://luma.com/google')).toBe(false);
  expect(isAnswer('https://evil.example.com/google?code=1', 'https://luma.com/google')).toBe(false);
});

function registry() {
  // In memory: nothing here waits on a disk (a busy machine's fsyncs once cost these tests seconds each).
  const dir = '/nonexistent/signin-unit';
  const store = new Store(':memory:');
  const kinds = new Map<string, Kind>([
    ['luma', kindOf({ kind: 'luma', name: 'Luma', interfaces: [], entry: '', signIn: { sites: ['https://luma.com'] } }, '')],
    ['google', kindOf({ kind: 'google', name: 'Google', interfaces: [], entry: '', signsIn: ['google'] }, '')],
    ['imap', kindOf({ kind: 'imap', name: 'IMAP', interfaces: [], entry: '' }, '')],
    ['site', kindOf({ kind: 'site', name: 'Website', interfaces: [], entry: '', signIn: { siteSetting: 'url' } }, '')],
  ]);
  const add = (id: string, kind: string, config: Record<string, unknown> = {}, seen: unknown = null, enabled = 1) =>
    store.run('INSERT INTO account (id, kind, label, config, token, dir, enabled, created_at, updated_at, seen_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, kind, `${kind} ${id}`, JSON.stringify(config), `tok-${id}`, join(dir, id), enabled, 0, 0, seen ? JSON.stringify(seen) : null);
  add('acc-luma', 'luma');
  add('acc-g1', 'google', {}, { email: 'ann@example.com' });
  add('acc-g2', 'google', {}, { email: 'ben@example.com' });
  add('acc-off', 'google', {}, null, 0);
  add('acc-mail', 'imap');
  add('acc-site', 'site', { url: 'https://shop.example.org/start?x=1' });
  add('acc-plain', 'site', { url: 'http://shop.example.org/' });
  const sent: { id: string; cmd: Record<string, unknown> }[] = [];
  let answer: unknown = null;
  const relays = new SignInRelays({
    store,
    kinds,
    statusOf: (id) => (id === 'acc-g2' ? 'attention' : 'online'),
    command: async (id, cmd) => {
      sent.push({ id, cmd });
      return answer;
    },
    log: () => {},
  });
  return { store, relays, sent, answerWith: (v: unknown) => (answer = v), done: () => store.db.close() };
}

test('the choices: the enabled accounts that sign in with that provider, by who they are', () => {
  const r = registry();
  try {
    const c = r.relays.choices('acc-luma', { url: link(LUMA) });
    expect(c).toMatchObject({ provider: 'google', name: 'Google', site: 'https://luma.com', remembered: null, asks: ['your email address', 'your name and picture'] });
    expect(c.choices).toEqual([
      { id: 'acc-g1', label: 'google acc-g1', who: 'ann@example.com', online: true },
      { id: 'acc-g2', label: 'google acc-g2', who: 'ben@example.com', online: false },
    ]);
  } finally {
    r.done();
  }
});

test("a relay goes to the chosen account and brings its answer back; a pick is remembered, or forgotten", async () => {
  const r = registry();
  try {
    r.answerWith({ url: 'https://luma.com/google?code=4%2Fxyz&state=st' });
    expect(await r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-g1', remember: true })).toEqual({ url: 'https://luma.com/google?code=4%2Fxyz&state=st' });
    // Linked (remembered): the provider's screens are gone through for you, as the account last seen.
    expect(r.sent).toEqual([{ id: 'acc-g1', cmd: expect.objectContaining({ t: 'signin.authorize', provider: 'google', url: link(LUMA), redirect: 'https://luma.com/google', site: 'https://luma.com', auto: true, who: 'ann@example.com' }) }]);
    expect(JSON.parse(r.store.account('acc-luma')!.config).signInWith).toEqual({ google: 'acc-g1' });
    expect(r.relays.choices('acc-luma', { url: link(LUMA) }).remembered).toBe('acc-g1');
    await r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-g1', remember: false });
    expect(JSON.parse(r.store.account('acc-luma')!.config).signInWith).toBeUndefined();
    // Not linked: you answer the provider's screens.
    expect(r.sent[1]!.cmd.auto).toBe(false);
  } finally {
    r.done();
  }
});

test('refused: another site, an account that cannot answer, an asker that does not sign in, an answer that is not the redirect', async () => {
  const r = registry();
  try {
    r.answerWith({ url: 'https://luma.com/google?code=1' });
    await expect(r.relays.relay('acc-luma', { url: link({ ...LUMA, redirect_uri: 'https://evil.example.com/cb' }), account: 'acc-g1' })).rejects.toThrow('not for this account');
    await expect(r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-mail' })).rejects.toThrow('cannot sign in');
    await expect(r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-off' })).rejects.toThrow('cannot sign in');
    await expect(r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-nope' })).rejects.toThrow('cannot sign in');
    await expect(r.relays.relay('acc-mail', { url: link(LUMA), account: 'acc-g1' })).rejects.toThrow('do not sign in');
    expect(() => r.relays.choices('acc-luma', { url: 'https://accounts.google.com/signin' })).toThrow('Not relayed');
    expect(r.sent).toHaveLength(0);
    r.answerWith({ url: 'https://evil.example.com/cb?code=1' });
    await expect(r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-g1' })).rejects.toThrow('did not send the sign-in back');
    r.answerWith(null);
    await expect(r.relays.relay('acc-luma', { url: link(LUMA), account: 'acc-g1' })).rejects.toThrow('did not send the sign-in back');
  } finally {
    r.done();
  }
});

test("a test origin counts only for an account that has one of its own", () => {
  const r = registry();
  try {
    const fake = 'http://127.0.0.1:9';
    const q = link({ ...LUMA, redirect_uri: `${fake}/google` }, 'http://127.0.0.1:8/o/oauth2/v2/auth');
    expect(() => r.relays.choices('acc-luma', { url: q })).toThrow('Not relayed');
    r.store.run('UPDATE account SET config = ? WHERE id = ?', JSON.stringify({ testOrigin: fake, testSignInOrigins: { google: 'http://127.0.0.1:8' } }), 'acc-luma');
    expect(r.relays.choices('acc-luma', { url: q }).site).toBe(fake);
  } finally {
    r.done();
  }
});

test("linked, but the site asks for more than who you are: the provider's screens are yours", async () => {
  const r = registry();
  try {
    r.answerWith({ url: 'https://luma.com/google?code=1' });
    const more = link({ ...LUMA, scope: `${LUMA.scope} https://www.googleapis.com/auth/calendar.readonly` });
    await r.relays.relay('acc-luma', { url: more, account: 'acc-g1', remember: true });
    expect(JSON.parse(r.store.account('acc-luma')!.config).signInWith).toEqual({ google: 'acc-g1' });
    expect(r.sent[0]!.cmd.auto).toBe(false);
  } finally {
    r.done();
  }
});

test("the general site kind: each account's own https address is its site, and nothing else", async () => {
  const r = registry();
  try {
    const shop = (redirect: string) => link({ ...LUMA, redirect_uri: redirect });
    expect(r.relays.choices('acc-site', { url: shop('https://shop.example.org/auth/google') }).site).toBe('https://shop.example.org');
    expect(() => r.relays.choices('acc-site', { url: shop('https://luma.com/google') })).toThrow('not for this account');
    expect(() => r.relays.choices('acc-site', { url: shop('https://www.shop.example.org/auth/google') })).toThrow('not for this account');
    // An address that is not https is no site.
    expect(() => r.relays.choices('acc-plain', { url: shop('https://shop.example.org/auth/google') })).toThrow('not for this account');
    r.answerWith({ url: 'https://shop.example.org/auth/google?code=1' });
    expect(await r.relays.relay('acc-site', { url: shop('https://shop.example.org/auth/google'), account: 'acc-g1', remember: true })).toEqual({ url: 'https://shop.example.org/auth/google?code=1' });
  } finally {
    r.done();
  }
});

test('starting a sign-in links the account first, sends signin.start, and refuses at once what could not answer', async () => {
  const r = registry();
  try {
    r.answerWith({ ok: true, note: 'the answer went to the site' });
    // Refused before anything is linked or sent: an account that cannot answer, an asker that does not ask, no provider.
    expect(() => r.relays.begin('acc-luma', 'google', 'acc-mail')).toThrow('cannot sign in with Google');
    expect(() => r.relays.begin('acc-luma', 'google', 'acc-off')).toThrow('cannot sign in with Google');
    expect(() => r.relays.begin('acc-mail', 'google', 'acc-g1')).toThrow('do not sign in with other accounts');
    expect(() => r.relays.begin('acc-luma', 'nope', 'acc-g1')).toThrow('no sign-in provider');
    expect(r.sent).toEqual([]);
    expect(JSON.parse(r.store.account('acc-luma')!.config).signInWith).toBeUndefined();

    expect(await r.relays.start('acc-luma', 'google', 'acc-g1')).toEqual({ ok: true, note: 'the answer went to the site' });
    expect(JSON.parse(r.store.account('acc-luma')!.config).signInWith).toEqual({ google: 'acc-g1' });
    expect(r.sent).toEqual([{ id: 'acc-luma', cmd: { t: 'signin.start', provider: 'google' } }]);

    // In the background: under way at once, its ending kept for whoever asks.
    r.answerWith({ ok: false, note: 'no Google sign-in started on the page' });
    const s = r.relays.begin('acc-site', 'google', 'acc-g2');
    expect(s).toMatchObject({ provider: 'google', account: 'acc-g2', running: true, ok: null });
    for (let i = 0; i < 200 && r.relays.starts.get('acc-site')?.running; i++) await Bun.sleep(1);
    expect(r.relays.starts.get('acc-site')).toMatchObject({ running: false, ok: false, note: 'no Google sign-in started on the page' });
  } finally {
    r.done();
  }
});
