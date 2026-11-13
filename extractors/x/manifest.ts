import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * X direct messages (legacy DMs and encrypted XChat) from the real x.com web client, signed in in a sandboxed browser
 * (packages/browser), as Discord's: the page's own chat objects are read and driven from inside the page (docs/x.md).
 */
export default {
  kind: 'x',
  name: 'X',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: "Runs X's web app in a sandboxed browser on this machine and reads your direct messages (legacy DMs and encrypted XChat) from inside it; dither-chat reads and writes through it. You sign in to X once in the live view.",
    next: 'Open its live view and sign in to X as on your desktop (password, second factor, any check X shows). If X asks for your XChat PIN on this browser, enter it there too. It goes online once your chats load.',
  },
} satisfies Manifest;
