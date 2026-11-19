import type { Manifest } from '@dither-accounts/manager/kinds';

/** A Lemmy account through its instance's HTTP API (v3): replies, mentions, communities, threads, answering (docs/lemmy.md). */
export default {
  kind: 'lemmy',
  name: 'Lemmy',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Reads the replies and mentions waiting for you, your subscribed communities, what is hot across your instance and each " +
      "post's comments through your instance's own API, and comments, posts and upvotes as you when you ask. It signs in with " +
      'your password and keeps the session your instance gives, signing in again by itself when that ends.',
    fields: [
      {
        key: 'instance',
        label: 'Instance',
        placeholder: 'https://lemmy.example',
        pattern: '^(https?://)?[^\\s/@]+/?$',
        hint: "your instance's address, like https://lemmy.example",
      },
      { key: 'username', label: 'Username or email', placeholder: 'ann', pattern: '^\\S+$', hint: 'your username on that instance (without @ or the instance), or your email' },
      { key: 'password', label: 'Password', secret: true },
      {
        key: 'totp',
        label: 'Two-factor secret (only if you turned it on)',
        placeholder: 'the base32 secret or otpauth:// link, or a 6-digit code',
        secret: true,
        optional: true,
        pattern: '^(\\d{6}|otpauth://\\S+|[A-Za-z2-7 =-]{16,})$',
        hint: 'the secret your authenticator app holds (so it can sign in again by itself), or the current 6-digit code for this sign-in only',
      },
    ],
    next: 'It signs in now. Without two-factor secret, a later sign-in that needs a code asks you for one here.',
  },
} satisfies Manifest;
