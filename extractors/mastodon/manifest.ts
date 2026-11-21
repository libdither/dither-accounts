import type { Manifest } from '@dither-accounts/manager/kinds';

/** A Mastodon account through its server's REST API: notifications, home timelines, threads, answering (docs/mastodon.md). */
export default {
  kind: 'mastodon',
  name: 'Mastodon',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Reads your Mastodon notifications, home timeline, trending posts and threads through your server's own API, and posts, " +
      'replies, favourites and boosts as you when you ask. It registers itself as an app on your server; you sign in there in ' +
      'your browser and paste back the code it shows. Or paste an access token made under Preferences → Development.',
    fields: [
      {
        key: 'instance',
        label: 'Server',
        placeholder: 'https://mastodon.example',
        pattern: '^(https?://)?[^\\s/@]+/?$',
        hint: 'your server\'s address, like https://mastodon.example (the part after the second @ in your address)',
      },
      {
        key: 'token',
        label: 'Access token (instead of signing in)',
        placeholder: 'from Preferences → Development → New application',
        secret: true,
        optional: true,
        pattern: '^\\S{20,}$',
        hint: 'an access token with the read, write and follow scopes, or leave it empty to sign in instead',
      },
    ],
    next: 'Without a token it asks you to sign in on your server: open the link it shows, approve, and paste the code back here.',
  },
} satisfies Manifest;
