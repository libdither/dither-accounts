import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * A view-only Monero wallet (monero-wallet-rpc against a remote node) as `statements` files, byte for byte what
 * dither-finance's connectors/monero.py wrote, and `monero.view` for key images (docs/monero.md). It can never spend.
 */
export default {
  kind: 'monero',
  name: 'Monero (view-only)',
  interfaces: ['statements', 'monero.view'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "A view-only Monero wallet: from your address and private view key it sees what the wallet received (and, given key images, what it spent), and pulls its transfers once a day for an app such as dither-finance. It cannot spend. The scan runs here against a remote node, which sees this machine's IP but never the keys.",
    fields: [
      { key: 'address', label: 'Primary address', secret: true, placeholder: '4…', pattern: '^[48][1-9A-HJ-NP-Za-km-z]{94}$', hint: 'kept with the view key, not shown on the page' },
      { key: 'viewKey', label: 'Private view key', secret: true, placeholder: '64 hex characters', pattern: '^[0-9a-fA-F]{64}$' },
      { key: 'restoreHeight', label: 'Restore height', optional: true, placeholder: '0', pattern: '^\\d{0,9}$', hint: 'the block to start scanning from: a height before your first transaction saves hours' },
      { key: 'node', label: 'Node', optional: true, placeholder: 'host:port', pattern: '^[\\w.\\-]+:\\d{1,5}$', hint: 'empty: the first of a few public nodes that answers' },
    ],
    next: 'The first pull makes the wallet and scans from the restore height (hours from 0). Key images from the full wallet go in with monero.keyImages.',
  },
} satisfies Manifest;
