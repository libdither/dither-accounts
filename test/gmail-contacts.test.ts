/**
 * mail.contacts for Gmail without a browser (extractors/google/src/gmail/contacts.ts): the request as Gmail's To field
 * sends it, the answer read in its recorded layout (fake-google.ts peopleAnswer, invented people) and refused in any
 * other, and the call's cache, readiness and errors. The browser side is in google-browser.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { StatusError } from '@dither-accounts/link';
import { CACHE_MS, type ContactsAnswer, ContactsLayoutError, contactsRequest, GmailContacts, readContacts, TROUBLE_MS } from '../extractors/google/src/gmail/contacts.ts';
import { FAKE_PEOPLE, peopleAnswer, personMatches } from './fake-google.ts';

const err = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as StatusError;

describe('the request and the answer', () => {
  test("the body is Gmail compose's own: affinity type 134, the query, client information [1, 2], the page size", () => {
    expect(contactsRequest('ann', 8)).toEqual([134, 'ann', [1, 2], 8]);
  });

  test('people in the server order, each address once, groups and people without an address left out, names as shown', () => {
    const r = readContacts(peopleAnswer(FAKE_PEOPLE));
    expect(r.contacts).toEqual([
      { email: 'ann.lee@example.com', name: 'Ann Lee' },
      { email: 'alice@example.org', name: null }, // no name: the address alone
      // the same address in other case is the first one again; a name that is the address is no name
      { email: 'albert@example.net', name: null },
      { email: 'bob.stone@example.com', name: 'Bob Stone' },
      { email: 'carol@example.com', name: 'Carol Ames' },
    ]);
    expect(r.groups).toBe(1);
  });

  test('nothing matched: [] (live), or a list answer with no suggestions', () => {
    expect(readContacts([]).contacts).toEqual([]);
    expect(readContacts([null, ['meta']]).contacts).toEqual([]);
    expect(readContacts([[], ['meta']]).contacts).toEqual([]);
  });

  test('a suggestion with one person and no address (a phone number, say) is left out; all of them so is a layout error', () => {
    const one = peopleAnswer([FAKE_PEOPLE[0]!, FAKE_PEOPLE[1]!]) as any;
    one[0][1][0][0][0][1] = null;
    expect(readContacts(one).contacts.map((c) => c.email)).toEqual(['ann.lee@example.com']);
    one[0][0][0][0][0][1] = null;
    expect(() => readContacts(one)).toThrow(new ContactsLayoutError('json[0][…][0][0][0][1]', 'an address on at least one suggestion', 'none'));
  });

  test('another layout is refused, saying where and what kind of thing, never a value', () => {
    const at = (json: unknown) => {
      try {
        readContacts(json);
      } catch (e) {
        expect(e).toBeInstanceOf(ContactsLayoutError);
        return (e as Error).message;
      }
      return null;
    };
    expect(at(peopleAnswer(FAKE_PEOPLE, { swapped: true }))).toBe('at json[0][0][0][0][0][1][0]: expected an address, got a list of 2');
    expect(at({ people: [] })).toBe('at json: expected a list, got an object');
    expect(at(['ann.lee@example.com'])).toBe('at json[0]: expected the list of suggestions, got a string');
    // One level deeper does not pass for a group: every member is read as a person.
    const deeper = peopleAnswer([FAKE_PEOPLE[0]!]) as any;
    deeper[0][0] = [deeper[0][0]];
    expect(at(deeper)).toBe('at json[0][0][0][0][1][0]: expected a profile or nothing, got a string');
    const named = peopleAnswer([FAKE_PEOPLE[0]!]) as any;
    named[0][0][0][0][0][0][1] = 'Ann Lee';
    expect(at(named)).toBe('at json[0][0][0][0][0][0][1]: expected a name or nothing, got a string');
    const notAddress = peopleAnswer([FAKE_PEOPLE[0]!]) as any;
    notAddress[0][0][0][0][0][1][0] = 'Ann Lee';
    expect(at(notAddress)).toBe('at json[0][0][0][0][0][1][0]: expected an address, got a string');
    for (const m of [at(named), at(notAddress)]) expect(m).not.toContain('Ann');
  });
});

/** A transport answering as the fake's endpoint does, counting its calls. */
function fakeTransport() {
  const sent: unknown[][] = [];
  const next: ContactsAnswer[] = [];
  const t = async (body: unknown[]): Promise<ContactsAnswer> => {
    sent.push(body);
    const n = next.shift();
    if (n) return n;
    const [, q, , size] = body as [number, string, number[], number];
    return { status: 200, json: peopleAnswer(FAKE_PEOPLE.filter((p) => personMatches(p, q)).slice(0, size)) };
  };
  return { t, sent, next };
}

describe('GmailContacts', () => {
  test('an empty query answers nothing without asking; a query is trimmed; 8 by default, the To field asks 8 or more', async () => {
    const f = fakeTransport();
    const c = new GmailContacts(f.t);
    expect(await c.suggest({ query: '' })).toEqual({ contacts: [] });
    expect(await c.suggest({ query: '   ' })).toEqual({ contacts: [] });
    expect(f.sent).toEqual([]);
    // 'a': Ann, Alice, Ann again (other case), Albert, a group, Carol Ames.
    expect((await c.suggest({ query: '  a ' })).contacts.map((x) => x.email)).toEqual(['ann.lee@example.com', 'alice@example.org', 'albert@example.net', 'carol@example.com']);
    expect(f.sent).toEqual([[134, 'a', [1, 2], 8]]);
    expect((await c.suggest({ query: 'a', limit: 1 })).contacts.map((x) => x.email)).toEqual(['ann.lee@example.com']);
    expect(f.sent.length).toBe(1); // the same query and page size: from the cache
    await c.suggest({ query: 'b', limit: 50 });
    expect(f.sent.at(-1)).toEqual([134, 'b', [1, 2], 20]);
    await c.suggest({ query: 'c', limit: 0 });
    expect(f.sent.at(-1)).toEqual([134, 'c', [1, 2], 8]);
  });

  test('a minute of cache per query (without regard to case), then Google again', async () => {
    let now = 1_000_000;
    const f = fakeTransport();
    const c = new GmailContacts(f.t, { log: () => {}, now: () => now });
    await c.suggest({ query: 'Ann' });
    await c.suggest({ query: 'ann' });
    expect(f.sent.length).toBe(1);
    now += CACHE_MS - 1;
    await c.suggest({ query: 'ANN' });
    expect(f.sent.length).toBe(1);
    now += 1;
    await c.suggest({ query: 'ann' });
    expect(f.sent.length).toBe(2);
  });

  test('bad input is 400, without asking', async () => {
    const f = fakeTransport();
    const c = new GmailContacts(f.t);
    expect((await err(c.suggest({ query: 'a'.repeat(301) }))).status).toBe(400);
    expect((await err(c.suggest({ query: 'a', limit: 2.5 }))).status).toBe(400);
    expect((await err(c.suggest({ query: 7 }))).status).toBe(400);
    expect(f.sent).toEqual([]);
  });

  test('a page that cannot answer now: 503 unavailable, nothing asked (a cached answer still answers)', async () => {
    const f = fakeTransport();
    let why: string | null = null;
    const c = new GmailContacts(f.t, { log: () => {}, ready: () => why });
    await c.suggest({ query: 'ann' });
    why = 'Google is not signed in; sign in in the live view';
    expect((await c.suggest({ query: 'ann' })).contacts.length).toBe(1);
    const e = await err(c.suggest({ query: 'bob' }));
    expect([e.status, e.callCode, e.message]).toEqual([503, 'unavailable', why]);
    expect(f.sent.length).toBe(1);
  });

  test("Google's answers that are not suggestions: late 504, busy or signed out 503, broken 502 (details false a while)", async () => {
    let now = 5_000_000;
    const logs: string[] = [];
    const f = fakeTransport();
    let changes = 0;
    const c = new GmailContacts(f.t, { log: (_l, m) => logs.push(m), now: () => now, onChange: () => changes++ });
    const cases: [ContactsAnswer, number, string | undefined][] = [
      [{ status: 0, error: 'timeout' }, 504, undefined],
      [{ status: 401, code: 16 }, 503, 'unavailable'],
      [{ status: 429, code: 8 }, 503, 'unavailable'],
      [{ status: 503, code: 14 }, 503, 'unavailable'],
      [{ status: 200, error: 'not-json', page: 'challenge' }, 503, 'unavailable'],
      [{ status: 200, error: 'not-json', page: 'signin' }, 503, 'unavailable'],
      [{ status: 0, error: 'network' }, 503, 'unavailable'],
    ];
    for (const [i, [a, status, code]] of cases.entries()) {
      f.next.push(a);
      const e = await err(c.suggest({ query: `q${i}` }));
      expect([e.status, e.callCode]).toEqual([status, code]);
      expect(c.troubled()).toBeNull();
    }
    // A failure of the call itself: 502, kept (details.contacts false), logged once, and cleared by an answer.
    f.next.push({ status: 403, code: 7, error: 'no-key' });
    const nokey = await err(c.suggest({ query: 'x1' }));
    expect([nokey.status, nokey.message]).toEqual([502, "no API key the Gmail page carries is taken by Google's people suggestions (the last answered 403, code 7)"]);
    expect(c.troubled()).toBe(nokey.message);
    f.next.push({ status: 200, json: peopleAnswer(FAKE_PEOPLE, { swapped: true }) });
    const layout = await err(c.suggest({ query: 'x2' }));
    expect([layout.status, layout.message]).toEqual([502, "Gmail's people suggestions answer is not laid out as this extractor knows it (at json[0][0][0][0][0][1][0]: expected an address, got a list of 2); nothing was returned rather than possibly wrong people"]);
    f.next.push({ status: 400, code: 3 });
    expect((await err(c.suggest({ query: 'x3' }))).message).toBe('Google refused the people suggestions (400, code 3)');
    expect(c.troubled()).toBe('Google refused the people suggestions (400, code 3)');
    now += TROUBLE_MS;
    expect(c.troubled()).toBeNull(); // a while later, it is worth trying again
    f.next.push({ status: 400, code: 3 });
    await err(c.suggest({ query: 'x4' }));
    expect(c.troubled()).not.toBeNull();
    expect((await c.suggest({ query: 'carol' })).contacts).toEqual([{ email: 'carol@example.com', name: 'Carol Ames' }]);
    expect(c.troubled()).toBeNull();
    expect(changes).toBeGreaterThanOrEqual(4);
    // The log says what broke and that it mended: never a query or a person.
    expect(logs.filter((l) => l.startsWith('gmail contacts: '))).toEqual([
      "gmail contacts: no API key the Gmail page carries is taken by Google's people suggestions (the last answered 403, code 7)",
      `gmail contacts: ${layout.message}`,
      'gmail contacts: Google refused the people suggestions (400, code 3)',
      'gmail contacts: answering again',
    ]);
    for (const l of logs) for (const x of ['carol', 'Carol', 'x1', 'q0', 'example']) expect(l).not.toContain(x);
  });
});
