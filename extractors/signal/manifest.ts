import type { Manifest } from '@dither-accounts/manager/kinds';

/** Signal accounts: moved from dither-chat's packages/adapter-signal (docs/chat.md). */
export default {
  kind: 'signal',
  name: 'Signal',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Links this machine as another Signal device through signal-cli. Your phone stays in charge.',
    next: 'A code to scan shows here in a moment: on your phone, Signal → Settings → Linked devices → Link new device.',
  },
} satisfies Manifest;
