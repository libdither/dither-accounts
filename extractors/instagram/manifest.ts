import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Instagram direct messages from a signed-in browser (packages/browser): the real web app in a sandbox, read from its
 * own Relay store and driven through its own message modules (extractors/meta, docs/messenger.md).
 */
export default {
  kind: 'instagram',
  name: 'Instagram',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Runs Instagram (instagram.com/direct) in a sandboxed browser on this machine; you sign in once in the live view. dither-chat reads and writes your direct messages through it.',
    next: 'Open its live view and sign in to Instagram as on your desktop (password, two-factor, any check Instagram shows; those are yours). It goes online once your inbox is read.',
  },
} satisfies Manifest;
