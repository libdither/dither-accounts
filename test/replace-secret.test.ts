/** Replacing an account's sign-in on the page: secret add-form fields merged over secret.json, then a restart. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManager, kindOf, type Manager, type Manifest } from '@dither-accounts/manager';

const FAKE = resolve(import.meta.dir, '../extractors/fake');
const tokened: Manifest = {
  kind: 'tokened',
  name: 'Tokened',
  interfaces: ['test.echo'],
  entry: 'src/main.ts',
  add: { blurb: 'a fake with a token', fields: [{ key: 'token', label: 'Token', secret: true, pattern: '^t', hint: 'starts with t' }] },
};
const plain: Manifest = { kind: 'plain', name: 'Plain', interfaces: ['test.echo'], entry: 'src/main.ts', add: { blurb: 'no secrets' } };

let m: Manager;
let dir: string;
const post = (path: string, body: unknown) => fetch(m.url + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: m.url }, body: JSON.stringify(body) });
const secretOf = (id: string) => JSON.parse(readFileSync(join(m.store.account(id)!.dir, 'secret.json'), 'utf8'));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-secret-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['tokened', kindOf(tokened, FAKE)], ['plain', kindOf(plain, FAKE)]]) });
});
afterAll(async () => {
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a new token replaces the old one, the rest of the session stays, and nothing secret comes back', async () => {
  const id = ((await (await post('/api/accounts', { kind: 'tokened', label: 'T', secret: { token: 't-one' } })).json()) as { id: string }).id;
  expect(secretOf(id)).toEqual({ token: 't-one' });
  // What an extractor keeps beside it (a session) stays.
  writeFileSync(join(m.store.account(id)!.dir, 'secret.json'), JSON.stringify({ token: 't-one', session: 's' }));
  const r = await post(`/api/accounts/${id}/secret`, { secret: { token: 't-two', other: 'ignored' } });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain('t-two');
  expect(JSON.parse(text)).toEqual({ replaced: ['token'] });
  expect(secretOf(id)).toEqual({ token: 't-two', session: 's' });
});

test('what the form refuses, and kinds with nothing to replace', async () => {
  const id = m.store.accounts().find((a) => a.kind === 'tokened')!.id;
  expect((await post(`/api/accounts/${id}/secret`, { secret: { token: 'x' } })).status).toBe(400);
  expect((await post(`/api/accounts/${id}/secret`, { secret: {} })).status).toBe(400);
  expect(secretOf(id).token).toBe('t-two');
  const p = ((await (await post('/api/accounts', { kind: 'plain', label: 'P' })).json()) as { id: string }).id;
  expect((await post(`/api/accounts/${p}/secret`, { secret: { token: 't' } })).status).toBe(400);
});
