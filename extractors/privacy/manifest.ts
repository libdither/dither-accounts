import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Privacy.com in a sandboxed browser (packages/browser, extension only) whose extension carries its own passkey for
 * privacy.com: you sign in once in the live view and add a passkey in Privacy's settings; the key is made and kept by
 * this account (docs/privacy.md). Its `statements` are dither-finance's pcom.py pull, signing itself in with the passkey.
 */
export default {
  kind: 'privacy',
  name: 'Privacy.com',
  interfaces: ['privacy.session', 'statements'],
  entry: 'src/main.ts',
  passkeys: true,
  add: {
    blurb:
      "Runs Privacy.com's web app in a sandboxed browser on this machine, with its own passkey for privacy.com: you sign in once in the live view and add a passkey in Privacy's settings, and this account keeps the key (never shown to apps). Its transactions go to dither-finance as statements; when Privacy's short session has ended, it signs itself in with the passkey.",
    next: "Open its live view and sign in to Privacy as on your desktop. Then, in Privacy's Account → Settings → Security, add a passkey: this browser answers the prompt itself. Last, sign out and back in with the passkey to check it.",
  },
} satisfies Manifest;
