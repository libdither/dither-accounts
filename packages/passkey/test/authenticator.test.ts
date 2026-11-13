import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { Authenticator, type CreateOptions, derSignature, EDDSA, ES256, type PasskeyStore, rpFor, type StoredCredential, summarize, validCredentials, WebAuthnError } from '../src/authenticator.ts';
import { decode, encode } from '../src/cbor.ts';
import { FakeRp } from './fake-rp.ts';

const ORIGIN = 'https://app.privacy.com';
const DOMAINS = ['privacy.com'];
const userId = Buffer.from('user-1234').toString('base64url');

function memStore(): PasskeyStore & { creds: StoredCredential[]; saves: number } {
  const s = {
    creds: [] as StoredCredential[],
    saves: 0,
    load: () => structuredClone(s.creds),
    save: (c: StoredCredential[]) => {
      s.saves++;
      s.creds = structuredClone(c);
    },
  };
  return s;
}

const createOpts = (rp: FakeRp, challenge: string, extra: Partial<CreateOptions> = {}): CreateOptions => ({
  rp: { id: rp.rpId, name: 'Privacy' },
  user: { id: userId, name: 'me@example.com', displayName: 'Me' },
  challenge,
  pubKeyCredParams: [
    { type: 'public-key', alg: ES256 },
    { type: 'public-key', alg: -257 },
  ],
  attestation: 'none',
  ...extra,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WebAuthnError);
    return (e as WebAuthnError).code;
  }
  throw new Error('expected a WebAuthnError');
};

describe('with a fake relying party', () => {
  for (const [name, alg] of [
    ['ES256', ES256],
    ['Ed25519', EDDSA],
  ] as const) {
    test(`${name}: create registers, get signs in, the counter goes up every time`, async () => {
      const rp = new FakeRp('privacy.com', ORIGIN);
      const store = memStore();
      const auth = new Authenticator(store, DOMAINS);
      const ch = rp.challenge();
      const made = await auth.create(ORIGIN, createOpts(rp, ch, { pubKeyCredParams: [{ type: 'public-key', alg }] }));
      const reg = rp.register(ch, made, userId);
      expect(reg.alg).toBe(alg);
      expect(reg.counter).toBe(0);
      expect(made.transports).toEqual(['internal']);
      expect(store.creds).toHaveLength(1);
      expect(store.creds[0]!.signCount).toBe(0);

      for (let i = 1; i <= 3; i++) {
        const c = rp.challenge();
        const got = await auth.get(ORIGIN, { rpId: 'privacy.com', challenge: c, allowCredentials: [{ type: 'public-key', id: made.id }], userVerification: 'required' });
        expect(got).not.toBeNull();
        expect(rp.authenticate(c, got!)).toBe(i);
        expect(store.creds[0]!.signCount).toBe(i);
        expect(store.creds[0]!.lastUsedAt).toBeNumber();
      }
      // A discoverable sign-in (no allow list) finds it too and returns the user handle.
      const c = rp.challenge();
      const got = await auth.get(ORIGIN, { rpId: 'privacy.com', challenge: c });
      expect(got!.userHandle).toBe(userId);
      expect(rp.authenticate(c, got!)).toBe(4);
    });
  }

  test("the relying party's order of algorithms is its preference", async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const auth = new Authenticator(memStore(), DOMAINS);
    const ch = rp.challenge();
    const made = await auth.create(ORIGIN, createOpts(rp, ch, { pubKeyCredParams: [{ type: 'public-key', alg: EDDSA }, { type: 'public-key', alg: ES256 }] }));
    expect(made.publicKeyAlgorithm).toBe(EDDSA);
    expect(rp.register(ch, made, userId).alg).toBe(EDDSA);
    // RS256 only: refused, it cannot make one.
    expect(await code(auth.create(ORIGIN, createOpts(rp, rp.challenge(), { pubKeyCredParams: [{ type: 'public-key', alg: -257 }] })))).toBe('NotSupportedError');
  });

  test('rpId on a subdomain page: privacy.com from app.privacy.com, and app.privacy.com itself', async () => {
    for (const rpId of ['privacy.com', 'app.privacy.com']) {
      const rp = new FakeRp(rpId, ORIGIN);
      const auth = new Authenticator(memStore(), DOMAINS);
      const ch = rp.challenge();
      const made = await auth.create(ORIGIN, createOpts(rp, ch));
      rp.register(ch, made, userId);
      const c = rp.challenge();
      expect(rp.authenticate(c, (await auth.get(ORIGIN, { rpId, challenge: c }))!)).toBe(1);
    }
  });

  test('a credential for one rpId is not offered to another', async () => {
    const rp = new FakeRp('app.privacy.com', ORIGIN);
    const auth = new Authenticator(memStore(), DOMAINS);
    await auth.create(ORIGIN, createOpts(rp, rp.challenge()));
    expect(await auth.get(ORIGIN, { rpId: 'privacy.com', challenge: rp.challenge() })).toBeNull();
  });

  test('an allow list naming other credentials: null (the browser may try its own), and no counter moves', async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const store = memStore();
    const auth = new Authenticator(store, DOMAINS);
    await auth.create(ORIGIN, createOpts(rp, rp.challenge()));
    const saves = store.saves;
    expect(await auth.get(ORIGIN, { rpId: 'privacy.com', challenge: rp.challenge(), allowCredentials: [{ type: 'public-key', id: 'c29tZXRoaW5nLWVsc2U' }] })).toBeNull();
    expect(store.saves).toBe(saves);
    expect(store.creds[0]!.signCount).toBe(0);
  });

  test('excludeCredentials naming the one it holds: InvalidStateError, nothing new stored', async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const store = memStore();
    const auth = new Authenticator(store, DOMAINS);
    const made = await auth.create(ORIGIN, createOpts(rp, rp.challenge()));
    expect(await code(auth.create(ORIGIN, createOpts(rp, rp.challenge(), { excludeCredentials: [{ type: 'public-key', id: made.id }] })))).toBe('InvalidStateError');
    expect(store.creds).toHaveLength(1);
  });

  test('credProps is answered as a discoverable credential', async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const made = await new Authenticator(memStore(), DOMAINS).create(ORIGIN, createOpts(rp, rp.challenge(), { extensions: { credProps: true } }));
    expect(made.clientExtensionResults).toEqual({ credProps: { rk: true } });
  });
});

describe('the counter', () => {
  test('concurrent sign-ins get distinct, increasing counters', async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const store = memStore();
    const auth = new Authenticator(store, DOMAINS);
    const ch = rp.challenge();
    rp.register(ch, await auth.create(ORIGIN, createOpts(rp, ch)), userId);
    const chs = [rp.challenge(), rp.challenge(), rp.challenge(), rp.challenge()];
    const got = await Promise.all(chs.map((c) => auth.get(ORIGIN, { challenge: c, rpId: 'privacy.com' })));
    const counters = got.map((g) => new DataView(Buffer.from(g!.authenticatorData, 'base64url').buffer).getUint32(33));
    expect(counters).toEqual([1, 2, 3, 4]);
    expect(store.creds[0]!.signCount).toBe(4);
  });

  test('never goes back, even if the stored copy does (an older secret.json.bak)', async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const store = memStore();
    const auth = new Authenticator(store, DOMAINS);
    const ch = rp.challenge();
    rp.register(ch, await auth.create(ORIGIN, createOpts(rp, ch)), userId);
    for (let i = 0; i < 3; i++) {
      const c = rp.challenge();
      rp.authenticate(c, (await auth.get(ORIGIN, { rpId: 'privacy.com', challenge: c }))!);
    }
    store.creds[0]!.signCount = 1; // the file went back
    const c = rp.challenge();
    expect(rp.authenticate(c, (await auth.get(ORIGIN, { rpId: 'privacy.com', challenge: c }))!)).toBe(4);
  });

  test('is saved before the assertion is handed out: a failed save hands out nothing', async () => {
    const rp = new FakeRp('privacy.com', ORIGIN);
    const store = memStore();
    const auth = new Authenticator(store, DOMAINS);
    await auth.create(ORIGIN, createOpts(rp, rp.challenge()));
    store.save = () => {
      throw new Error('disk full');
    };
    expect(await code(auth.get(ORIGIN, { rpId: 'privacy.com', challenge: rp.challenge() }))).toBe('NotAllowedError');
  });

  test('a new process continues from the stored counter (secret.json on disk, mode 600)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dacc-privacy-'));
    try {
      const path = join(dir, 'secret.json');
      const file: PasskeyStore = { load: () => validCredentials(readSecretFile<any>(path).passkeys), save: (c) => writeSecretFile(path, { ...readSecretFile<any>(path), passkeys: c }) };
      const rp = new FakeRp('privacy.com', ORIGIN);
      const ch = rp.challenge();
      rp.register(ch, await new Authenticator(file, DOMAINS).create(ORIGIN, createOpts(rp, ch)), userId);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (let i = 1; i <= 2; i++) {
        const c = rp.challenge();
        expect(rp.authenticate(c, (await new Authenticator(file, DOMAINS).get(ORIGIN, { rpId: 'privacy.com', challenge: c }))!)).toBe(i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rpId and origin checks', () => {
  test('rpFor: the host or a parent domain of it, inside privacy.com, https only', () => {
    expect(rpFor('https://app.privacy.com', undefined, DOMAINS)).toBe('app.privacy.com');
    expect(rpFor('https://app.privacy.com', 'privacy.com', DOMAINS)).toBe('privacy.com');
    expect(rpFor('https://privacy.com', 'PRIVACY.COM', DOMAINS)).toBe('privacy.com');
    const refused = (o: string, rp: string | undefined) => {
      try {
        rpFor(o, rp, DOMAINS);
      } catch (e) {
        return (e as WebAuthnError).code;
      }
      return 'allowed';
    };
    expect(refused('https://evil.com', undefined)).toBe('NotAllowedError');
    expect(refused('https://evil.com', 'privacy.com')).toBe('SecurityError');
    expect(refused('https://privacy.com.evil.com', 'privacy.com')).toBe('SecurityError');
    expect(refused('https://notprivacy.com', 'privacy.com')).toBe('SecurityError');
    expect(refused('https://app.privacy.com', 'com')).toBe('NotAllowedError');
    expect(refused('https://app.privacy.com', 'other.privacy.com')).toBe('SecurityError');
    expect(refused('http://app.privacy.com', undefined)).toBe('SecurityError');
    expect(refused('http://localhost:8080', undefined)).toBe('NotAllowedError');
    expect(rpFor('http://localhost:8080', undefined, ['localhost'])).toBe('localhost');
    expect(refused('null', undefined)).toBe('SecurityError');
  });

  test('create and get refuse other sites, and store nothing for them', async () => {
    const store = memStore();
    const auth = new Authenticator(store, DOMAINS);
    const evil = new FakeRp('evil.com', 'https://evil.com');
    expect(await code(auth.create('https://evil.com', createOpts(evil, evil.challenge())))).toBe('NotAllowedError');
    expect(await code(auth.create(ORIGIN, createOpts(evil, evil.challenge())))).toBe('SecurityError');
    expect(store.creds).toHaveLength(0);
    // With a privacy.com credential held, another site still gets nothing.
    const rp = new FakeRp('privacy.com', ORIGIN);
    await auth.create(ORIGIN, createOpts(rp, rp.challenge()));
    expect(await code(auth.get('https://evil.com', { challenge: evil.challenge() }))).toBe('NotAllowedError');
    expect(await code(auth.get('https://evil.com', { rpId: 'privacy.com', challenge: evil.challenge() }))).toBe('SecurityError');
    expect(store.creds[0]!.signCount).toBe(0);
  });

  test('the origin in clientDataJSON is the caller’s, not one the request names', async () => {
    const rp = new FakeRp('privacy.com', 'https://app.privacy.com');
    const auth = new Authenticator(memStore(), DOMAINS);
    const ch = rp.challenge();
    const made = await auth.create('https://app.privacy.com/login?x=1', { ...createOpts(rp, ch), origin: 'https://evil.com' } as CreateOptions);
    expect(JSON.parse(Buffer.from(made.clientDataJSON, 'base64url').toString()).origin).toBe('https://app.privacy.com');
  });

  test('malformed input is refused', async () => {
    const auth = new Authenticator(memStore(), DOMAINS);
    const rp = new FakeRp('privacy.com', ORIGIN);
    expect(await code(auth.create(ORIGIN, createOpts(rp, '')))).toBe('NotAllowedError');
    expect(await code(auth.create(ORIGIN, createOpts(rp, 'not base64!')))).toBe('NotAllowedError');
    expect(await code(auth.create(ORIGIN, { ...createOpts(rp, rp.challenge()), user: { id: '' } }))).toBe('NotAllowedError');
    expect(await code(auth.get(ORIGIN, null as any))).toBe('NotAllowedError');
  });
});

test('summary shows only non-secret facts', async () => {
  const store = memStore();
  const auth = new Authenticator(store, DOMAINS, () => 1_700_000_000_000);
  expect(auth.summary()).toEqual({ enrolled: false, count: 0, newest: null });
  const rp = new FakeRp('privacy.com', ORIGIN);
  const made = await auth.create(ORIGIN, createOpts(rp, rp.challenge()));
  await auth.markVerified(made.id);
  const s = auth.summary();
  expect(s).toEqual({ enrolled: true, count: 1, newest: { idPrefix: made.id.slice(0, 8), rpId: 'privacy.com', algorithm: 'ES256', createdAt: 1_700_000_000_000, lastUsedAt: null, verifiedAt: 1_700_000_000_000 } });
  const text = JSON.stringify(s);
  for (const secret of [store.creds[0]!.privateKey, made.id, store.creds[0]!.userHandle!]) expect(text).not.toContain(secret);
  expect(summarize([])).toEqual({ enrolled: false, count: 0, newest: null });
});

test('validCredentials drops malformed entries', () => {
  expect(validCredentials(null)).toEqual([]);
  expect(validCredentials([{ id: 'x' }, { id: 'a', rpId: 'privacy.com', alg: -7, privateKey: 'k', signCount: 3, createdAt: 1 }])).toHaveLength(1);
  expect(validCredentials([{ id: 'a', rpId: 'privacy.com', alg: -7, privateKey: 'k', signCount: -1, createdAt: 1 }])).toHaveLength(0);
});

test('CBOR round trip and DER signatures', () => {
  const m = new Map<number | string, any>([
    [1, 2],
    [-1, 1],
    [-24, 1],
    [-25, 1],
    ['fmt', 'none'],
    [300, new Uint8Array(300).fill(7)],
    [70000, [1, 'x']],
  ]);
  expect(decode(encode(m))).toEqual(m);
  expect(Array.from(encode(-7))).toEqual([0x26]);
  expect(Array.from(encode(-257))).toEqual([0x39, 0x01, 0x00]);
  // r with its top bit set gets a 0x00 pad; s with leading zeros loses them.
  const raw = new Uint8Array(64);
  raw[0] = 0x80;
  raw[63] = 0x05;
  expect(Array.from(derSignature(raw).slice(0, 4))).toEqual([0x30, 2 + 33 + 3, 0x02, 33]);
  expect(Array.from(derSignature(raw).slice(-3))).toEqual([0x02, 1, 0x05]);
});
