import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Luma: events in your city (Explore, signed out too), your own events, who hosts and who is going as the site shows
 * it, your notifications, your events' blasts and Luma's chats, from luma.com in a sandboxed browser (packages/browser).
 * Reads and writes are the web app's own calls, made from inside its page (docs/luma.md).
 */
export default {
  kind: 'luma',
  name: 'Luma',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  // "Continue with Google" on luma.com, answered by a Google account here (docs/signin-relay.md).
  signIn: { sites: ['https://luma.com'] },
  add: {
    blurb: "Runs luma.com in a sandboxed browser on this machine: dither-chat's Feed shows your city's events (before you sign in too) and yours, with who hosts and who is going as Luma shows it; your notifications, your events' blasts and Luma's chats come in as conversations. You sign in to Luma once in the live view.",
    fields: [
      {
        key: 'city',
        label: 'City',
        placeholder: 'nyc',
        optional: true,
        pattern: '^[A-Za-z0-9][A-Za-z0-9 .,-]{0,59}$',
        hint: "One of Luma's cities, as its page's address names it (luma.com/nyc → nyc) or by name; empty for Luma's own pick",
      },
    ],
    next: 'Explore works now. Sign in to Luma in the live view (the emailed code, or whatever Luma asks) for your events, notifications and chats.',
  },
  settings: [
    {
      key: 'city',
      label: 'City',
      type: 'text',
      pattern: '[A-Za-z0-9][A-Za-z0-9 .,-]{0,59}',
      max: 60,
      placeholder: 'nyc',
      note: "Whose events Explore shows: one of Luma's cities (luma.com/discover), by the end of its address (nyc) or its name. Empty: Luma's own pick.",
    },
  ],
} satisfies Manifest;
