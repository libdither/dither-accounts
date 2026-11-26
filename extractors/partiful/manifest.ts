import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Partiful: the parties you are going to, hosting or invited to, the city's Explore listing (signed in or not), who is
 * going as Partiful shows it, each party's comments, host blasts and album, and Partiful's chats, from partiful.com in
 * a sandboxed browser (packages/browser). Reads and writes are the app's own calls, made from inside its page
 * (docs/partiful.md).
 */
export default {
  kind: 'partiful',
  name: 'Partiful',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  screen: true,
  add: {
    blurb:
      "Runs partiful.com in a sandboxed browser on this machine: Explore for a city (works before you sign in), your parties with who is going as Partiful shows it, each party's comments and host texts, and Partiful's chats, for dither-chat. You sign in to Partiful once in the live view with the code it texts you.",
    fields: [{ key: 'city', label: 'City (optional)', placeholder: "Partiful's explore place, like sf or nyc", optional: true, pattern: '[A-Za-z0-9][A-Za-z0-9-]{0,39}', hint: "Partiful's explore place as in partiful.com/explore/<place>, like sf or nyc" }],
    next: 'Explore works now. To see your own parties and chats, sign in to Partiful in the live view with the code it texts you.',
  },
  settings: [
    {
      key: 'city',
      label: 'City',
      type: 'text',
      note: "Partiful's explore place for the explore listing, as in partiful.com/explore/<place> (sf, nyc…); empty for Partiful's own default.",
      placeholder: 'sf',
      pattern: '[A-Za-z0-9][A-Za-z0-9-]{0,39}',
      max: 40,
    },
  ],
} satisfies Manifest;
