import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKinds } from '../packages/manager/src/kinds.ts';

const root = mkdtempSync(join(tmpdir(), 'dacc-kinds-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ext = (dir: string, manifest: string) => {
  mkdirSync(join(root, 'extractors', dir), { recursive: true });
  writeFileSync(join(root, 'extractors', dir, 'manifest.ts'), manifest);
};

test('an extractor whose manifest does not load is left out, and the others still load', async () => {
  ext('good', `export default { kind: 'good', name: 'Good', interfaces: ['test.echo'], entry: 'src/main.ts' };`);
  ext('broken', `export default {{ this is not TypeScript`);
  ext('unknown', `export default { kind: 'unknown', name: 'Unknown', interfaces: ['no.such.interface'], entry: 'src/main.ts' };`);
  ext('twin', `export default { kind: 'good', name: 'Good again', interfaces: ['test.echo'], entry: 'src/main.ts' };`);
  mkdirSync(join(root, 'extractors', 'wip'), { recursive: true });
  writeFileSync(join(root, 'extractors', 'wip', 'manifest.wip.ts'), `export default {{`);
  const skipped: string[] = [];
  const kinds = await loadKinds(root, (d) => skipped.push(d));
  expect([...kinds.keys()]).toEqual(['good']);
  expect(skipped.sort()).toEqual(['broken', 'twin', 'unknown']);
});
