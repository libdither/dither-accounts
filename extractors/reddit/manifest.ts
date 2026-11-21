import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * A Reddit account's front page, inbox and comment threads, from old.reddit.com signed in in a sandboxed browser
 * (packages/browser): reads and writes are the page's own calls, made from inside it (docs/reddit.md).
 */
export default {
  kind: 'reddit',
  name: 'Reddit',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: "Runs Reddit in a sandboxed browser on this machine; dither-chat's Feed reads your front page, inbox and comment threads through it, and can vote, comment and post. You sign in to Reddit once in the live view.",
    next: 'Open its live view and sign in to Reddit as on your desktop (password, any code or check Reddit shows). It goes online once old.reddit.com shows you signed in.',
  },
} satisfies Manifest;
