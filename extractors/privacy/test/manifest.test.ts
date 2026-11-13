import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadKinds } from '../../../packages/manager/src/kinds.ts';
import manifest from '../manifest.ts';

const repo = resolve(import.meta.dir, '../../..');
const ext = join(import.meta.dir, '../src/extension');

test('the privacy kind loads with its interface and an add form', async () => {
  const kinds = await loadKinds(repo, (d, e) => {
    if (d === 'privacy') throw e;
  });
  const k = kinds.get('privacy')!;
  expect(k).toBeDefined();
  expect(k.name).toBe('Privacy.com');
  expect(k.interfaces).toEqual(['privacy.session', 'statements']);
  expect([...k.opIface.keys()]).toEqual(['privacy.session', 'statements.list', 'statements.fetch', 'statements.refresh', 'statements.ack', 'statements.accounts']);
  expect(k.ifaces[0]!.ops['privacy.session']!.level).toBe('read');
  expect(existsSync(join(k.dir, k.entry))).toBe(true);
  // No fields: nothing is typed into the page; you sign in in the live view.
  expect((manifest.add as { fields?: unknown[] }).fields ?? []).toEqual([]);
  expect(manifest.add?.next).toContain('passkey');
});

test('the extension: privacy.com only, no debugger, the hook in the page at document_start, top frame only', () => {
  const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  expect(m.manifest_version).toBe(3);
  expect(m.permissions).not.toContain('debugger');
  expect(m.permissions).not.toContain('webRequest');
  const privacyOnly = (p: string) => p === 'https://privacy.com/*' || p === 'https://*.privacy.com/*';
  expect(m.host_permissions.every(privacyOnly)).toBe(true);
  for (const cs of m.content_scripts) {
    expect(cs.matches.every(privacyOnly)).toBe(true);
    expect(cs.all_frames ?? false).toBe(false);
    expect(cs.run_at).toBe('document_start');
  }
  expect(m.content_scripts.find((c: any) => c.js.includes('hook.js')).world).toBe('MAIN');
  for (const f of ['hook.js', 'content.js', 'sw.js']) expect(existsSync(join(ext, f))).toBe(true);
  // The page hook never holds a key: it has no WebCrypto signing and no config.
  const hook = readFileSync(join(ext, 'hook.js'), 'utf8');
  expect(hook).not.toMatch(/crypto\.subtle|config\.json|privateKey/);
});
