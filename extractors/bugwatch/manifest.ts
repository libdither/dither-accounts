import type { Manifest } from '@dither-accounts/manager/kinds';

/** Your own services' errors as notices, each new bug handed to a T3 coding thread (docs/bugwatch.md). */
export default {
  kind: 'bugwatch',
  name: 'Bug watch',
  interfaces: ['notifications'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Watches your own services' error files and logs on this machine, groups errors by fingerprint, and raises a notice " +
      'for each new bug (or a spike of an old one); it can start a T3 coding thread to look into each, a few a day. ' +
      'Which files it reads, and the thread command, are in a JSON config file you keep outside the repository (docs/bugwatch.md).',
    fields: [
      {
        key: 'config',
        label: 'Config file',
        placeholder: '/path/to/bugwatch.json',
        pattern: '^/\\S.*\\.json$',
        hint: 'the absolute path of its JSON config (docs/bugwatch.md has the shape)',
      },
    ],
    next: 'It reads the last 24 hours of each source now; bugs found there are listed without a notification.',
  },
} satisfies Manifest;
