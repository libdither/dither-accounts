import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Charles Schwab in a sandboxed browser (packages/browser, extension only): you sign in by hand in the live view
 * (password and Schwab's code; nothing here answers a code), add the account's own passkey, and a pull of Schwab's own exports follows by itself:
 * History (brokerage and bank) and Realized Gain/Loss as CSV, for dither-finance (docs/schwab.md). Read only: it
 * presses only the account picker, the date range, Search and Export; it cannot trade or move money.
 */
export default {
  kind: 'schwab',
  name: 'Charles Schwab',
  interfaces: ['statements'],
  entry: 'src/main.ts',
  passkeys: true,
  add: {
    blurb:
      "Runs schwab.com in a sandboxed browser on this machine, with its own passkey for schwab.com: you sign in once by hand in the live view and add a passkey in Schwab's security settings, and this account keeps the key (never shown to apps) and signs itself in with it. It exports your History and Realized Gain/Loss as CSV, the way the pages' Export buttons do, for an app such as dither-finance. Read only: it cannot trade or move money.",
    next: "Open its live view and sign in to Schwab as on your desktop, password and code; the first pull starts by itself. Then add a passkey in Schwab's security settings (this browser answers the prompt itself), and last, log out and back in with the passkey to check it. Anything you export or print to PDF there yourself is handed over too.",
  },
} satisfies Manifest;
