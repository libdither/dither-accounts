import type { Manifest } from '@dither-accounts/manager/kinds';

/** Matrix accounts: moved from dither-chat's packages/adapter-matrix (docs/chat.md). */
export default {
  kind: 'matrix',
  name: 'Matrix',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Talks to your homeserver with the Matrix API directly: no browser, no bridge. It signs in once with your password and keeps only the session.',
    fields: [
      { key: 'homeserver', label: 'Homeserver', placeholder: 'https://matrix.org', optional: true, pattern: '^https?://\\S+$', hint: 'a URL like https://matrix.org (or leave it empty to look it up from your user ID)' },
      { key: 'userId', label: 'User ID', placeholder: '@you:matrix.org', pattern: '^@[^:\\s]+:\\S+$', hint: 'a Matrix ID looks like @name:server.org' },
      { key: 'password', label: 'Password', secret: true },
    ],
    next: 'It signs in now. Encryption stays off until you set it up (dither-chat, or the action setupEncryption).',
  },
} satisfies Manifest;
