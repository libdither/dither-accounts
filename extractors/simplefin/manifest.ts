import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * SimpleFIN Bridge (bridge.simplefin.org): your banks' and cards' transactions through one access URL, as
 * `statements` files, byte for byte what dither-finance's simplefin/sfin.py wrote (docs/simplefin.md).
 */
export default {
  kind: 'simplefin',
  name: 'SimpleFIN Bridge',
  interfaces: ['statements'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Your banks' and cards' transactions from SimpleFIN Bridge, pulled once a day as the bridge's own files, for an app such as dither-finance. Read only: SimpleFIN cannot move money.",
    fields: [
      {
        key: 'setupToken',
        label: 'Setup token',
        secret: true,
        optional: true,
        placeholder: 'the token from bridge.simplefin.org → Apps → New connection',
        pattern: '^[A-Za-z0-9+/=_-]{20,}$',
        hint: 'used once: the account claims it for an access URL and keeps only that',
      },
      {
        key: 'accessUrl',
        label: 'Or: an access URL',
        secret: true,
        optional: true,
        placeholder: 'https://…@…/simplefin',
        pattern: '^https?://\\S+$',
        hint: 'one already claimed; leave the token empty then',
      },
    ],
    next: 'It claims the token now (a token works once) and pulls at its daily time; statements.refresh pulls now.',
  },
} satisfies Manifest;
