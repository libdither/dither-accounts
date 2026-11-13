import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Google from a signed-in browser (packages/browser), as Discord is; google-api is the OAuth way in (docs/google.md).
 * `mail` is Gmail read through its own page, read-only for now (docs/google.md, "Gmail mail").
 */
export default {
  kind: 'google',
  name: 'Google',
  interfaces: ['google.calendar', 'mail'],
  entry: 'src/main.ts',
  add: { blurb: 'Runs Google Calendar and Gmail in a sandboxed browser on this machine; you sign in to Google once in the live view.' },
} satisfies Manifest;
