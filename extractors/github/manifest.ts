import type { Manifest } from '@dither-accounts/manager/kinds';

/** GitHub's notifications through its REST API with a classic personal access token (docs/github.md). */
export default {
  kind: 'github',
  name: 'GitHub',
  interfaces: ['notifications'],
  entry: 'src/main.ts',
  add: {
    blurb:
      'Your GitHub notifications, polled the way GitHub asks (X-Poll-Interval, Last-Modified), for apps to read and clear. ' +
      'It needs a classic personal access token with the notifications scope (github.com → Settings → Developer settings → ' +
      'Personal access tokens → Tokens (classic)); add the repo scope too if you want the issues and pull requests of private ' +
      'repositories resolved (their state and link). Fine-grained tokens cannot read notifications.',
    fields: [
      {
        key: 'token',
        label: 'Classic token',
        placeholder: 'ghp_…',
        secret: true,
        // GitHub's notifications API does not take fine-grained or GitHub App tokens.
        pattern: '^(?!github_pat_|ghu_|ghs_)\\S{20,}$',
        hint: 'a classic token (it starts ghp_) with the notifications scope: fine-grained and GitHub App tokens cannot read notifications',
      },
      {
        key: 'apiUrl',
        label: 'API URL (GitHub Enterprise only)',
        placeholder: 'https://github.example.com/api/v3',
        optional: true,
        pattern: '^https?://[^\\s/]+(/\\S*)?$',
        hint: "your GitHub Enterprise Server's API, like https://github.example.com/api/v3 (leave it empty for github.com)",
      },
    ],
    next: 'It checks the token and its scopes now; what is missing shows here. Notifications already unread are not announced: apps list them.',
  },
} satisfies Manifest;
