import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Messenger from a signed-in browser (packages/browser): the real web app in a sandbox, read from its own LightSpeed
 * database and driven through its own code (extractors/meta, docs/messenger.md).
 */
export default {
  kind: 'messenger',
  name: 'Messenger',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Runs Messenger (messenger.com) in a sandboxed browser on this machine; you sign in once in the live view. dither-chat reads and writes through it.',
    fields: [
      {
        key: 'site',
        label: 'Where Messenger runs',
        optional: true,
        default: 'messenger',
        pattern: '^(messenger|facebook)$',
        hint: '"messenger" (messenger.com) or "facebook" (facebook.com/messages)',
      },
    ],
    next: 'Open its live view and sign in to Messenger as on your desktop (password, two-factor, any check Meta shows; those are yours). If Meta asks for your end-to-end encryption PIN, enter it there too. It goes online once your chats are read.',
  },
} satisfies Manifest;
