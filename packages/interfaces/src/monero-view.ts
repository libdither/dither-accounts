/**
 * `monero.view`: the monero kind's own small interface (docs/monero.md). A view-only wallet cannot spend, and cannot
 * tell which of its outputs were spent until it knows their key images; this hands it the file the full wallet
 * exported. It changes what the wallet knows, so it is manage, not read. Nothing here sends XMR.
 */
import { iface, op, s } from '@dither-accounts/spec';

export const moneroView = iface({
  name: 'monero.view',
  version: 1,
  describe: "A view-only Monero wallet's key images (what lets it see what was spent). It can never send.",
  levels: {
    manage: 'Give your view-only Monero wallet key images from the full wallet',
  },
  ops: {
    'monero.keyImages': op(
      'manage',
      'Key images exported from the full wallet (Feather: Wallet → Advanced → Export key images; CLI: export_key_images), base64; the next pull imports them',
      s.object({ base64: s.string }),
      s.typed<{ saved: boolean; size: number }>(),
      60_000,
    ),
  },
  events: {},
});
