import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * A Haveno node (RetoSwap) through the daemon's gRPC API, as an `exchange` account, and the Haveno desktop app on the
 * same data in this account's sandbox with a live view, on demand (docs/haveno.md).
 */
export default {
  kind: 'haveno',
  name: 'Haveno',
  interfaces: ['exchange'],
  entry: 'src/main.ts',
  add: {
    blurb:
      'A Haveno node (Monero peer-to-peer exchange) that already runs on this machine, as a system service: its balances, offers, trades ' +
      'and trade chats for apps to read and, with a write grant, to trade with. Apps can never send XMR out of the wallet. ' +
      "Open the desktop app to use Haveno's own screens in a live view: the node stops meanwhile and comes back when the app quits. " +
      "Leave everything empty for a node on its defaults (gRPC on 127.0.0.1:1201).",
    fields: [
      { key: 'address', label: 'gRPC address', optional: true, placeholder: '127.0.0.1:1201', pattern: '^[\\w.\\-\\[\\]:]+:\\d{1,5}$', hint: "the daemon's --apiPort, as host:port" },
      { key: 'dataDir', label: 'Data directory', optional: true, placeholder: '~/.local/share/Haveno-reto', pattern: '^/\\S+$', hint: "the node's --appDataDir, an absolute path (the desktop app opens it)" },
      {
        key: 'apiPassword',
        label: 'API password',
        secret: true,
        optional: true,
        placeholder: 'empty: HAVENO_API_PASSWORD in ~/.config/haveno/daemon.env',
        hint: "the daemon's --apiPassword; empty reads HAVENO_API_PASSWORD from ~/.config/haveno/daemon.env",
      },
    ],
    next: 'It finds the node now. A locked account asks here for its password: kept in memory (so the account opens again after a restart of the node), on disk only if you tick remember.',
  },
} satisfies Manifest;
