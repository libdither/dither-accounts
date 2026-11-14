import { expect, test } from 'bun:test';
import { authorizeTarget, isCallback, magicLinkOk, sameEmail, signedInLayer, state } from '../src/flow.ts';

const B = 'https://claude.ai';
const auth = (q: Record<string, string>, path = '/oauth/authorize', origin = B) => `${origin}${path}?${new URLSearchParams(q)}`;
const good = { code: 'true', client_id: 'x', response_type: 'code', redirect_uri: 'http://localhost:54545/callback', scope: 'user:inference', code_challenge: 'c', code_challenge_method: 'S256', state: 's' };

test('only claude.ai magic links with a token are opened', () => {
  expect(magicLinkOk(`${B}/magic-link#abc.def`, B)).toBe(true);
  expect(magicLinkOk(`${B}/magic-link`, B)).toBe(false);
  expect(magicLinkOk(`${B}/magic-link#`, B)).toBe(false);
  expect(magicLinkOk('https://claude.ai.evil.example/magic-link#abc', B)).toBe(false);
  expect(magicLinkOk(`${B}/login#abc`, B)).toBe(false);
  expect(magicLinkOk('not a url', B)).toBe(false);
});

test('an authorize URL must be claude.ai, a code request with PKCE, redirecting to this machine', () => {
  expect(authorizeTarget(auth(good), B)).toEqual({ redirect: 'http://localhost:54545/callback' });
  expect(authorizeTarget(auth({ ...good, redirect_uri: 'http://127.0.0.1:1455/cb' }), B)).toEqual({ redirect: 'http://127.0.0.1:1455/cb' });
  expect('why' in authorizeTarget(auth(good, '/oauth/authorize', 'https://evil.example'), B)).toBe(true);
  expect('why' in authorizeTarget(auth(good, '/login'), B)).toBe(true);
  expect('why' in authorizeTarget(auth({ ...good, redirect_uri: 'https://evil.example/callback' }), B)).toBe(true);
  expect('why' in authorizeTarget(auth({ ...good, redirect_uri: 'https://localhost:54545/callback' }), B)).toBe(true);
  expect('why' in authorizeTarget(auth({ ...good, response_type: 'token' }), B)).toBe(true);
  const { code_challenge, ...noPkce } = good;
  expect('why' in authorizeTarget(auth(noPkce), B)).toBe(true);
});

test('the callback is the redirect with a code or an error', () => {
  const r = 'http://localhost:54545/callback';
  expect(isCallback(`${r}?code=a&state=s`, r)).toBe(true);
  expect(isCallback(`${r}?error=access_denied&state=s`, r)).toBe(true);
  expect(isCallback(`${r}?state=s`, r)).toBe(false);
  expect(isCallback(`${r}x?code=a`, r)).toBe(false);
  expect(isCallback(`${B}/oauth/authorize?code=a`, r)).toBe(false);
});

test('status: another account signed in, or a held check, is an attention', () => {
  const v = { signedIn: true, email: 'A@x.org', expectedEmail: 'a@x.org', hold: null };
  expect(sameEmail('A@x.org ', 'a@x.org')).toBe(true);
  expect(state(v).status).toBe('online');
  expect(signedInLayer(v).state).toBe('ok');
  expect(state({ ...v, email: 'b@x.org' }).status).toBe('attention');
  expect(signedInLayer({ ...v, email: 'b@x.org' }).state).toBe('failed');
  expect(state({ ...v, hold: { message: 'm', since: 1 } }).attention?.liveView).toBe(true);
  expect(state({ ...v, signedIn: false }).status).toBe('online');
  expect(signedInLayer({ ...v, signedIn: false }).state).toBe('waiting');
});
