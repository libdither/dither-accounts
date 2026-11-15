import type { Manifest } from '@dither-accounts/manager/kinds';

export default {
  kind: 'fake',
  name: 'Fake (tests)',
  interfaces: ['test.echo'],
  entry: 'src/main.ts',
  settings: [{ key: 'loud', label: 'Loud', type: 'boolean', note: 'A setting for tests: it does nothing.' }],
} satisfies Manifest;
