import type { Manifest } from '@dither-accounts/manager/kinds';

/** A Zulip account through its organization's REST API and real-time event queue (docs/zulip.md). */
export default {
  kind: 'zulip',
  name: 'Zulip',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Talks to your Zulip organization with Zulip's own API, as its apps do: no browser. Channels and their topics, direct " +
      'messages, reactions, polls, starred messages and reminders come as they happen. Give it an API key (Zulip: Personal ' +
      'settings → Account & privacy → API key), or your password once, which it swaps for a key and forgets.',
    fields: [
      { key: 'server', label: 'Organization URL', placeholder: 'https://chat.example.org', pattern: '^(https?://)?[^\\s/@]+(/.*)?$', hint: 'the address you open Zulip at, like https://chat.example.org or example.zulipchat.com' },
      { key: 'email', label: 'Email', placeholder: 'you@example.org', pattern: '^\\S+@\\S+$', hint: 'the email you sign in to Zulip with (for a bot, its bot email)' },
      { key: 'apiKey', label: 'API key', secret: true, optional: true, pattern: '^[A-Za-z0-9]{20,}$', hint: 'from Personal settings → Account & privacy → API key, or leave it empty and give your password' },
      { key: 'password', label: 'Password (instead of an API key)', secret: true, optional: true, hint: 'used once to get an API key, then dropped; an organization that signs in with SSO wants the API key' },
    ],
    next: 'It signs in now and reads your channels, topics and direct messages.',
  },
} satisfies Manifest;
