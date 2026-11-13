import type { Manifest } from '@dither-accounts/manager/kinds';

/** A read-only .ics / webcal feed as one calendar (docs/ics.md). */
export default {
  kind: 'ics',
  name: 'Calendar feed (.ics)',
  interfaces: ['calendar'],
  entry: 'src/main.ts',
  add: {
    blurb: 'A read-only calendar from an .ics or webcal:// link (a published or "secret address" calendar, holidays, a team schedule). It checks it every ten minutes and says what changed.',
    fields: [
      {
        key: 'url',
        label: 'Feed URL',
        secret: true,
        placeholder: 'webcal://… or https://….ics',
        pattern: '^(webcals?|https?)://\\S+$',
        hint: 'a link starting with webcal://, https:// or http://; a private feed address is a password, so it is kept like one',
      },
    ],
    next: 'It fetches the feed now; its events are there once the calendar layer is ok. Writes are refused: change the calendar where it is published.',
  },
} satisfies Manifest;
