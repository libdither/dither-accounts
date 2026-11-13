/**
 * Who may ask (callerFor and the kinds' FramePolicy), as Schwab's passkey needs it: Schwab's sign-in widget comes from
 * sws-gateway-nr.schwab.com, maybe in a frame on www or client.schwab.com, so a same-site subframe is answered there,
 * with the client data Chromium would write for it; Privacy stays top-frame only.
 */
import { describe, expect, test } from 'bun:test';
import { Authenticator, type Caller, callerFor, type CreateOptions, ES256, type PasskeyStore, type StoredCredential, WebAuthnError } from '../src/authenticator.ts';
import { FakeRp } from './fake-rp.ts';

const SCHWAB = ['schwab.com'];
const GATEWAY = 'https://sws-gateway-nr.schwab.com';
const WWW = 'https://www.schwab.com';
const CLIENT = 'https://client.schwab.com';
const userId = Buffer.from('schwab-user').toString('base64url');

function memStore(): PasskeyStore & { creds: StoredCredential[] } {
  const s = { creds: [] as StoredCredential[], load: () => structuredClone(s.creds), save: (c: StoredCredential[]) => void (s.creds = structuredClone(c)) };
  return s;
}
const frame = (origin: string, top: string, ancestors?: string[]): Caller => ({ origin, top: false, topOrigin: top, ancestors: ancestors ?? [top] });
const createOpts = (rp: FakeRp, challenge: string, rpId = rp.rpId): CreateOptions => ({
  rp: { id: rpId, name: 'Schwab' },
  user: { id: userId, name: 'me', displayName: 'Me' },
  challenge,
  pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
});
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WebAuthnError);
    return (e as WebAuthnError).code;
  }
  return 'answered';
};
const refused = (c: string | Caller, frames: 'top' | 'same-site' = 'same-site') => {
  try {
    callerFor(c, SCHWAB, frames);
    return 'allowed';
  } catch (e) {
    return (e as WebAuthnError).code;
  }
};

describe('callerFor', () => {
  test('a top frame: its own origin, never cross-origin', () => {
    expect(callerFor(WWW + '/', SCHWAB, 'same-site')).toEqual({ origin: WWW, crossOrigin: false, topOrigin: null });
    expect(callerFor({ origin: GATEWAY, top: true, topOrigin: GATEWAY }, SCHWAB, 'top')).toEqual({ origin: GATEWAY, crossOrigin: false, topOrigin: null });
  });

  test('a same-site subframe on another schwab.com host: answered, cross-origin, with the top origin', () => {
    expect(callerFor(frame(GATEWAY, WWW), SCHWAB, 'same-site')).toEqual({ origin: GATEWAY, crossOrigin: true, topOrigin: WWW });
    expect(callerFor(frame(GATEWAY, CLIENT, [WWW, CLIENT]), SCHWAB, 'same-site')).toEqual({ origin: GATEWAY, crossOrigin: true, topOrigin: CLIENT });
    // A subframe of the same origin as every frame above it is not cross-origin.
    expect(callerFor(frame(WWW, WWW), SCHWAB, 'same-site')).toEqual({ origin: WWW, crossOrigin: false, topOrigin: null });
  });

  test('refused: a cross-site frame, either way round', () => {
    expect(refused(frame('https://evil.com', WWW))).toBe('NotAllowedError');
    expect(refused(frame(GATEWAY, 'https://evil.com'))).toBe('NotAllowedError');
    // An ancestor in between that is another site's.
    expect(refused(frame(GATEWAY, WWW, ['https://evil.com', WWW]))).toBe('NotAllowedError');
    expect(refused(frame(GATEWAY, 'https://schwab.com.evil.com'))).toBe('NotAllowedError');
  });

  test('refused: a frame that is not https, or in a page that is not', () => {
    expect(refused(frame('http://sws-gateway-nr.schwab.com', WWW))).toBe('NotAllowedError');
    expect(refused(frame(GATEWAY, 'http://www.schwab.com'))).toBe('NotAllowedError');
    expect(refused(frame('null', WWW))).toBe('SecurityError'); // no usable origin at all
  });

  test('refused: a subframe when the kind answers top frames only (Privacy), and a subframe with no page reported', () => {
    expect(refused(frame(GATEWAY, WWW), 'top')).toBe('NotAllowedError');
    expect(refused({ origin: GATEWAY, top: false })).toBe('NotAllowedError');
  });
});

describe('Schwab: an authenticator for schwab.com that answers same-site frames', () => {
  test('create and get from the gateway frame on www.schwab.com, rpId schwab.com, checked by the relying party', async () => {
    const rp = new FakeRp('schwab.com', GATEWAY, WWW);
    const store = memStore();
    const auth = new Authenticator(store, SCHWAB, Date.now, 'same-site');
    const ch = rp.challenge();
    const made = await auth.create(frame(GATEWAY, WWW), createOpts(rp, ch));
    expect(rp.register(ch, made, userId).alg).toBe(ES256);
    const cd = JSON.parse(Buffer.from(made.clientDataJSON, 'base64url').toString());
    expect(Object.keys(cd)).toEqual(['type', 'challenge', 'origin', 'crossOrigin', 'topOrigin']);
    for (let i = 1; i <= 2; i++) {
      const c = rp.challenge();
      expect(rp.authenticate(c, (await auth.get(frame(GATEWAY, WWW), { rpId: 'schwab.com', challenge: c }))!)).toBe(i);
    }
    // The same passkey from a top-level gateway page (no frame): crossOrigin false.
    const top = new FakeRp('schwab.com', GATEWAY);
    top.creds = rp.creds;
    const c = top.challenge();
    expect(top.authenticate(c, (await auth.get(GATEWAY, { rpId: 'schwab.com', challenge: c }))!)).toBe(3);
  });

  test('rpId: the frame host or a parent of it inside schwab.com; evil.com and schwab.com.evil.com refused', async () => {
    const store = memStore();
    const auth = new Authenticator(store, SCHWAB, Date.now, 'same-site');
    const rp = new FakeRp('schwab.com', GATEWAY, WWW);
    expect(await codeOf(auth.create(frame(GATEWAY, WWW), createOpts(rp, rp.challenge(), 'evil.com')))).toBe('SecurityError');
    expect(await codeOf(auth.create(frame(GATEWAY, WWW), createOpts(rp, rp.challenge(), 'schwab.com.evil.com')))).toBe('SecurityError');
    expect(await codeOf(auth.create(frame(GATEWAY, WWW), createOpts(rp, rp.challenge(), 'www.schwab.com')))).toBe('SecurityError');
    expect(await codeOf(auth.create(frame(GATEWAY, WWW), createOpts(rp, rp.challenge(), 'com')))).toBe('NotAllowedError');
    // A schwab.com.evil.com page asking for itself is outside schwab.com.
    expect(await codeOf(auth.create('https://schwab.com.evil.com', createOpts(rp, rp.challenge(), 'schwab.com.evil.com')))).toBe('NotAllowedError');
    expect(await codeOf(auth.create('https://evil.com', createOpts(rp, rp.challenge(), 'evil.com')))).toBe('NotAllowedError');
    expect(store.creds).toHaveLength(0);
    // rpId sws-gateway-nr.schwab.com itself is the frame's own host: allowed.
    expect(await codeOf(auth.create(frame(GATEWAY, WWW), createOpts(rp, rp.challenge(), 'sws-gateway-nr.schwab.com')))).toBe('answered');
  });

  test('refusals in frames store nothing and move no counter', async () => {
    const store = memStore();
    const auth = new Authenticator(store, SCHWAB, Date.now, 'same-site');
    const rp = new FakeRp('schwab.com', GATEWAY, WWW);
    await auth.create(frame(GATEWAY, WWW), createOpts(rp, rp.challenge()));
    const before = structuredClone(store.creds);
    for (const c of [frame('https://evil.com', WWW), frame(GATEWAY, 'https://evil.com'), frame('http://sws-gateway-nr.schwab.com', WWW), frame(GATEWAY, 'http://www.schwab.com')]) {
      expect(await codeOf(auth.get(c, { rpId: 'schwab.com', challenge: rp.challenge() }))).toBe('NotAllowedError');
      expect(await codeOf(auth.create(c, createOpts(rp, rp.challenge())))).toBe('NotAllowedError');
    }
    expect(store.creds).toEqual(before);
  });

  test('Privacy keeps top frames only: the same frame is refused there', async () => {
    const auth = new Authenticator(memStore(), ['privacy.com']);
    expect(auth.frames).toBe('top');
    const rp = new FakeRp('privacy.com', 'https://app.privacy.com');
    expect(await codeOf(auth.create(frame('https://app.privacy.com', 'https://privacy.com'), createOpts(rp, rp.challenge())))).toBe('NotAllowedError');
  });

  test("related origins: rpId www.schwab.com on client.schwab.com, as Schwab asks, only when www lists client", async () => {
    const store = memStore();
    const asked: string[] = [];
    let list: string[] = [CLIENT];
    const auth = new Authenticator(store, SCHWAB, Date.now, 'same-site', async (rp) => {
      asked.push(rp);
      return list;
    });
    const rp = new FakeRp('www.schwab.com', CLIENT);
    const ch = rp.challenge();
    rp.register(ch, await auth.create(CLIENT, createOpts(rp, ch)), userId);
    expect(store.creds.map((c) => c.rpId)).toEqual(['www.schwab.com']);
    const g = rp.challenge();
    expect(rp.authenticate(g, (await auth.get(CLIENT, { rpId: 'www.schwab.com', challenge: g }))!)).toBeGreaterThan(0);
    expect(asked.every((r) => r === 'www.schwab.com')).toBe(true);
    // Not listed, the list unreachable, or a foreign rpId (never fetched): Chromium's SecurityError, nothing stored.
    const before = structuredClone(store.creds);
    list = ['https://other.schwab.com'];
    expect(await codeOf(auth.get(CLIENT, { rpId: 'www.schwab.com', challenge: rp.challenge() }))).toBe('SecurityError');
    const failing = new Authenticator(store, SCHWAB, Date.now, 'same-site', async () => {
      throw new Error('offline');
    });
    expect(await codeOf(failing.get(CLIENT, { rpId: 'www.schwab.com', challenge: rp.challenge() }))).toBe('SecurityError');
    asked.length = 0;
    list = [CLIENT, 'https://evil.com'];
    expect(await codeOf(auth.create(CLIENT, createOpts(rp, rp.challenge(), 'evil.com')))).toBe('SecurityError');
    expect(await codeOf(auth.create('https://evil.com', createOpts(rp, rp.challenge(), 'www.schwab.com')))).toBe('SecurityError');
    expect(asked).toEqual([]); // neither a foreign rpId nor a foreign page fetches anything
    expect(store.creds).toEqual(before);
    // Without a fetcher (Privacy), the old rule.
    expect(await codeOf(new Authenticator(store, SCHWAB, Date.now, 'same-site').get(CLIENT, { rpId: 'www.schwab.com', challenge: rp.challenge() }))).toBe('SecurityError');
  });
});
