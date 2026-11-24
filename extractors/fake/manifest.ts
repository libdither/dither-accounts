import type { Manifest } from '@dither-accounts/manager/kinds';

export default {
  kind: 'fake',
  name: 'Fake (tests)',
  interfaces: ['test.echo'],
  entry: 'src/main.ts',
  settings: [
    { key: 'loud', label: 'Loud', type: 'boolean', note: 'A setting for tests: it does nothing.' },
    { key: 'motto', label: 'Motto', type: 'text', note: 'A line of text for tests: it does nothing.', placeholder: 'a few words', pattern: '[a-z ]+', max: 20 },
  ],
} satisfies Manifest;
