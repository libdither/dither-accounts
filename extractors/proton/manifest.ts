import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Proton Mail from a signed-in browser (packages/browser), as Google is: the real Mail web app in a sandbox, its own
 * API called from inside the page, bodies and attachments decrypted here with the keys the session unlocks (or by the
 * page's own crypto proxy when that unlock fails), mail sent through the web app's own composer code when the page
 * exposes it (docs/proton.md). The imap kind's Proton Bridge preset stays for paid plans.
 */
export default {
  kind: 'proton',
  name: 'Proton Mail',
  interfaces: ['mail'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Runs Proton Mail in a sandboxed browser on this machine; you sign in to Proton once in the live view (with "Keep me signed in"). Works on free plans: no Proton Bridge.',
    next: 'Open its live view and sign in to Proton as on your desktop (password, second factor, any check Proton shows), with "Keep me signed in" ticked. It goes online once your keys open.',
  },
} satisfies Manifest;
