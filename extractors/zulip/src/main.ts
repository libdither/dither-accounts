/**
 * The zulip extractor: one Zulip account, run by the manager as `bun extractors/zulip/src/main.ts` with DITHER_* in
 * the environment (packages/chat-protocol/src/adapter.ts). docs/zulip.md says what it does.
 *
 * Config (DITHER_ACCOUNT_CONFIG): { server: "https://chat.example.org", email: "you@example.org" }
 * Secret ($DITHER_ACCOUNT_DIR/secret.json): { apiKey } or { password }, which it swaps for an API key on first start.
 */
import { linkHub } from '@dither-chat/protocol/client';
import { ZulipAdapter } from './adapter.ts';

const adapter = new ZulipAdapter();
const hub = linkHub({
  onConnect: () => adapter.onConnect(),
  onCommand: (cmd) => adapter.command(cmd),
  onShutdown: () => adapter.shutdown(),
});
adapter.start(hub);

process.on('unhandledRejection', (e) => hub.log('error', `unhandled rejection: ${String((e as Error)?.stack ?? e)}`));
