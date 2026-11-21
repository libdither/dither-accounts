/**
 * packages/approval: the statement's bytes, hashes, fingerprints and signatures, against a vector made with
 * dither-chat's own packages/approvals/src/statement.ts (the hub and its CLI verify the same bytes), and the request
 * checks devices run.
 */
import { expect, test } from 'bun:test';
import { askText, checkRequest, derSignature, displayHash, fingerprint, fromB64u, keyStatement, messageHash, parseAsk, parseStatement, rawSignature, sha256hex, signText, statementText, verifySignature } from '@dither-accounts/approval';

// Made by dither-chat's statement.ts (statementText, derSignature over WebCrypto, fingerprint) with a throwaway key.
const V = {
  payload: 'dither-merge-v1\nrepo system-config\ntarget main\nbranch review/fix-caddy\nbase aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nhead bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ntree cccccccccccccccccccccccccccccccccccccccc\n',
  title: 'Merge review/fix-caddy into main (system-config)',
  body: 'abc1234 Fix the thing',
  text:
    'dither-approval-v1\nid apv_3qJ0d1x8Yc4mT2bE9kQwZp\nkind merge\nasker review\ncreated 1763600000000\nexpires 1763603600000\npayload-sha256 a5ef3ad01063c74515442676b5a1382a5ae29ebf9abaf037506270e3c6bbfb67\ndisplay-sha256 3b92353b34a058b025893ca7289cd63e40b370872e9120f98de2168e8c45ffeb\naction approve\nmessage-sha256 2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df\ndevice dev_Q2hTcFk3a0xYb1pW\nsigned 1763600123456\n',
  spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEug5uJZHz+ZsGO5B5pNd8nD6VdNzdTyUxnIQIeIkXc36pj+7iSawvErf8g9qgU3HQU8HdikG5pRVjYWP3NvuA0A==',
  sig: 'MEYCIQDsjRUVPhrh1L8OCukDCsYTX-UF928WdU3NpwtkF5GlDgIhAPp1nGs4z-fHCjrXzhDnsDUdNd1OATA2m-9LCs7Szm1N',
  fingerprint: '01:89:69:6d:41:2b:8e:27',
};
const FIELDS = { id: 'apv_3qJ0d1x8Yc4mT2bE9kQwZp', kind: 'merge', asker: 'review', created: 1763600000000, expires: 1763603600000, payloadSha256: sha256hex(V.payload), displaySha256: displayHash(V.title, V.body), action: 'approve', messageSha256: messageHash('ok'), device: 'dev_Q2hTcFk3a0xYb1pW', signed: 1763600123456 };

test('the statement is the reference’s bytes, and its signature checks here', async () => {
  expect(statementText(FIELDS)).toBe(V.text);
  expect(parseStatement(V.text)).toEqual(FIELDS);
  expect(fingerprint(V.spki)).toBe(V.fingerprint);
  expect(await verifySignature(V.spki, V.text, V.sig)).toBe(true);
  expect(await verifySignature(V.spki, V.text.replace('approve', 'deny'), V.sig)).toBe(false);
  expect(messageHash(null)).toBe(sha256hex(''));
});

test('the ask parses only in canonical form', () => {
  const ask = askText(FIELDS);
  expect(V.text.startsWith(ask)).toBe(true);
  expect(ask.split('\n').length).toBe(9);
  expect(parseAsk(ask)).toEqual({ id: FIELDS.id, kind: 'merge', asker: 'review', created: FIELDS.created, expires: FIELDS.expires, payloadSha256: FIELDS.payloadSha256, displaySha256: FIELDS.displaySha256 });
  for (const bad of [ask.slice(0, -1), ask.replace('created 1763600000000', 'created 01763600000000'), ask.replace('kind merge', 'kind Merge'), ask + 'x\n', ask.replace('asker review\n', ''), V.text]) expect(typeof parseAsk(bad)).toBe('string');
});

test('DER and raw signatures convert both ways; our signatures verify', async () => {
  const raw = rawSignature(fromB64u(V.sig))!;
  expect(raw.length).toBe(64);
  expect(Buffer.from(derSignature(raw)).toString('base64url')).toBe(V.sig);
  expect(rawSignature(new Uint8Array([0x30, 1, 2]))).toBeNull();
  const k = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', k.publicKey)).toString('base64');
  const text = keyStatement('dev_Q2hTcFk3a0xYb1pW', 'desk', spki);
  expect(text).toBe(`dither-approver-key-v1\ndev_Q2hTcFk3a0xYb1pW\ndesk\n${spki}`);
  for (let i = 0; i < 20; i++) expect(await verifySignature(spki, `${text}${i}`, await signText(k.privateKey, `${text}${i}`))).toBe(true);
});

test('checkRequest: the device’s checks', () => {
  const now = 1763600000500;
  const display = { kind: 'merge', asker: 'review', title: V.title, body: V.body, payload: V.payload, urgency: 'normal', actions: [{ id: 'approve', label: 'Approve', needs: 'signed' }, { id: 'deny', needs: 'any' }] };
  const ask = askText(FIELDS);
  const ok = checkRequest({ id: FIELDS.id, ask, display }, now);
  expect(typeof ok).toBe('object');
  if (typeof ok === 'string') return;
  expect(ok.display.actions[1]).toEqual({ id: 'deny', label: 'deny', needs: 'any' });
  const bad = (r: Record<string, unknown>, at = now) => checkRequest({ id: FIELDS.id, ask, display, ...r }, at);
  expect(bad({ id: 'apv_AAAAAAAAAAAAAAAAAAAAAA' })).toContain('another request');
  expect(bad({ display: { ...display, title: 'Other' } })).toContain('display-sha256');
  expect(bad({ display: { ...display, body: 'Other' } })).toContain('display-sha256');
  expect(bad({ display: { ...display, payload: V.payload.replace('main', 'dev') } })).toContain('payload-sha256');
  expect(bad({ display: { ...display, kind: 'deploy' } })).toContain('kind');
  expect(bad({ display: { ...display, title: `${V.title}\n` } })).toContain('title');
  expect(bad({ display: { ...display, actions: [{ id: 'approve', needs: 'signed' }] } })).toContain('deny');
  expect(bad({ display: { ...display, actions: [{ id: 'deny', needs: 'signed' }] } })).toContain('deny');
  expect(bad({ display: { ...display, actions: [{ id: 'deny', needs: 'any' }, { id: 'deny', needs: 'any' }] } })).toContain('twice');
  expect(bad({}, FIELDS.expires)).toBe('it has expired');
});
