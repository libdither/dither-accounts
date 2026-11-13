import type { Manifest } from '@dither-accounts/manager/kinds';

/** Discord accounts: moved from dither-chat's packages/adapter-discord (docs/chat.md). */
export default {
  kind: 'discord',
  name: 'Discord',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Runs the real Discord web client in a sandboxed browser on this machine; dither-chat reads and writes through it.',
    next: 'Its live view opens once the browser is up: sign in to Discord there, once.',
  },
} satisfies Manifest;
