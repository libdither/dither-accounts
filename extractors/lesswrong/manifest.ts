import type { Manifest } from '@dither-accounts/manager/kinds';

/** A LessWrong account (or another ForumMagnum forum's) through the site's GraphQL API: notifications, posts, comment threads, karma votes and comments (docs/lesswrong.md). */
export default {
  kind: 'lesswrong',
  name: 'LessWrong',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Reads your LessWrong notifications, posts by the people you subscribe to, the frontpage's feed and each post's " +
      'comments through the site\'s own API, and upvotes and comments as you when you ask. It never marks anything read. ' +
      'It signs in once with your password and keeps only the sign-in the site gives (not the password); if you sign in ' +
      'with Google or GitHub, paste your login token instead.',
    fields: [
      {
        key: 'username',
        label: 'Username or email',
        placeholder: 'Ann Lee',
        optional: true,
        hint: 'as you sign in on the site; leave it empty when you paste a login token',
      },
      { key: 'password', label: 'Password', secret: true, optional: true, hint: 'used once to sign in, then forgotten' },
      {
        key: 'token',
        label: 'Login token (instead of a password)',
        placeholder: 'the value of the loginToken cookie',
        secret: true,
        optional: true,
        pattern: '^[A-Za-z0-9_-]{16,200}$',
        hint: "for accounts that sign in with Google or GitHub: in your browser's developer tools, the loginToken cookie of the site",
      },
      {
        key: 'site',
        label: 'Site (only for another ForumMagnum forum)',
        placeholder: 'https://www.lesswrong.com',
        default: 'https://www.lesswrong.com',
        optional: true,
        pattern: '^(https?://)?[^\\s/@]+/?$',
        hint: 'the EA Forum or the Alignment Forum run the same code: https://forum.effectivealtruism.org, https://www.alignmentforum.org',
      },
    ],
    next: 'It signs in now. Should the site stop taking the sign-in, it asks for your password (or a new token) here.',
  },
} satisfies Manifest;
