import type { Manifest } from '@dither-accounts/manager/kinds';

export default { kind: 'fake', name: 'Fake (tests)', interfaces: ['test.echo'], entry: 'src/main.ts' } satisfies Manifest;
