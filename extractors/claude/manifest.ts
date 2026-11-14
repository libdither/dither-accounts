import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * A Claude (claude.ai) account in a sandboxed browser (packages/browser, extension only), so the manager's `cliproxy`
 * provider can sign the CLIProxyAPI hub in to its subscription: claude.ai is signed in with the link it emails to the
 * account's address (the provider reads it from that address's mail account here), and CLIProxyAPI's OAuth request is
 * approved on claude.ai's own consent page (docs/claude.md). It never reads chats or sends prompts.
 */
export default {
  kind: 'claude',
  name: 'Claude',
  interfaces: ['claude'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "A Claude account in a sandboxed browser on this machine, for the CLIProxyAPI hub that serves your Claude subscriptions to Claude Code. It signs in with the link claude.ai emails you (read from that address's mail account here) and approves the hub's sign-in on claude.ai's own page. It never reads your chats. Usually added through the cliproxy provider: `cli.ts cliproxy add-claude <email>`.",
    fields: [{ key: 'email', label: 'Email', placeholder: 'the email you sign in to Claude with', pattern: '^[^@\\s]+@[^@\\s]+$', hint: 'its sign-in links are read from the mail account here with this address' }],
    next: 'The cliproxy provider signs it in and links it to the hub; a check only you can answer shows up here with the live view.',
  },
} satisfies Manifest;
