import type { Manifest } from '@dither-accounts/manager/kinds';

/** A Bluesky account through the AT Protocol's HTTP API: notifications, timelines, threads, answering (docs/bluesky.md). */
export default {
  kind: 'bluesky',
  name: 'Bluesky',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      'Reads your Bluesky notifications, your Following timeline, Discover and threads through your own server\'s API, and ' +
      'posts, replies, quotes, likes and reposts as you when you ask. It signs in with an app password (not your main ' +
      'password) and keeps the session Bluesky gives, refreshing it by itself.',
    fields: [
      {
        key: 'handle',
        label: 'Handle or email',
        placeholder: 'alice.bsky.social',
        pattern: '^@?\\S+$',
        hint: 'your handle, like alice.bsky.social (or your own domain), or the email you sign in with',
      },
      {
        key: 'password',
        label: 'App password',
        placeholder: 'xxxx-xxxx-xxxx-xxxx',
        secret: true,
        hint: 'made under Settings → Privacy and security → App passwords; it can be revoked there at any time',
      },
      {
        key: 'service',
        label: 'Server (only if you are not on Bluesky\'s own)',
        placeholder: 'https://bsky.social',
        optional: true,
        pattern: '^(https?://)?[^\\s/@]+/?$',
        hint: 'where it signs in when you give an email; with a handle it finds your server by itself',
      },
    ],
    next: 'It signs in now. If Bluesky emails you a sign-in code, type it here when the account asks.',
  },
} satisfies Manifest;
