import type { Manifest } from '@dither-accounts/manager/kinds';

/** Google through its REST API with your own OAuth client (packages/manager/src/providers/google.ts signs in). */
export default { kind: 'google-api', name: 'Google (API, your OAuth client)', interfaces: ['google.calendar'], entry: 'src/main.ts' } satisfies Manifest;
