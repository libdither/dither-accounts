import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Substack: the inbox of posts from the publications you subscribe to, Notes, your activity (likes, restacks, comments,
 * replies, new subscribers) and post and note threads, from substack.com signed in in a sandboxed browser
 * (packages/browser). Reads and writes are the reader's own calls, made from inside its page (docs/substack.md).
 */
export default {
  kind: 'substack',
  name: 'Substack',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  screen: true,
  add: {
    blurb: "Runs substack.com in a sandboxed browser on this machine and reads your Substack inbox, Notes and activity from inside it; dither-chat's Feed page reads and answers through it (likes, restacks, comments, Notes). You sign in to Substack once in the live view.",
    next: 'Sign in to Substack in the live view (the emailed link or code, or your password). It goes online once you are signed in.',
  },
} satisfies Manifest;
