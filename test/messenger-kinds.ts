/**
 * The manager's kinds with messenger and instagram in them, whichever manifest they have: manifest.ts once they are
 * done, manifest.wip.ts while the live manager must not see them yet (it loads manifest.ts only).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Kind, kindOf, loadKinds } from '@dither-accounts/manager';

export const ROOT = resolve(import.meta.dir, '..');

export async function metaKinds(): Promise<Map<string, Kind>> {
  const kinds = await loadKinds(ROOT, () => {});
  for (const k of ['messenger', 'instagram']) {
    if (kinds.has(k)) continue;
    const dir = join(ROOT, 'extractors', k);
    const file = existsSync(join(dir, 'manifest.ts')) ? join(dir, 'manifest.ts') : join(dir, 'manifest.wip.ts');
    kinds.set(k, kindOf((await import(file)).default, dir));
  }
  return kinds;
}
