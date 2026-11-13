import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Venmo in a sandboxed browser (packages/browser, extension only): you sign in by hand in the live view and a pull of
 * your statement CSVs follows by itself, byte for byte what dither-finance's connectors/venmo.py wrote (docs/venmo.md).
 * Read only: nothing here pays, requests or transfers.
 */
export default {
  kind: 'venmo',
  name: 'Venmo',
  interfaces: ['statements'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Runs Venmo's web app in a sandboxed browser on this machine. You sign in by hand in the live view; right after that it downloads your statements the way Venmo's Statements page does, for an app such as dither-finance. Read only: it cannot pay, request or transfer.",
    next: 'Open its live view and sign in to Venmo as on your desktop. The pull starts by itself once you are in; Venmo ends a session after about 30 idle minutes, so the daily pull skips when you are signed out.',
  },
} satisfies Manifest;
