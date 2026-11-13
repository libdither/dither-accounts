import type { Manifest } from '@dither-accounts/manager/kinds';

/** A fake chat account for tests (dither-chat's remote mode): the `chat` interface over the real adapter wire. */
export default { kind: 'chat-fake', name: 'Fake chat (tests)', interfaces: ['chat'], entry: 'src/main.ts' } satisfies Manifest;
