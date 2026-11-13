import type { Manifest } from '@dither-accounts/manager/kinds';

/** WhatsApp accounts: moved from dither-chat's packages/adapter-whatsapp (docs/chat.md). */
export default {
  kind: 'whatsapp',
  name: 'WhatsApp',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: 'Links this machine as another WhatsApp device, like WhatsApp Web. Open WhatsApp on your phone at least every two weeks or the link lapses.',
    next: 'A code to scan shows here in a moment (WhatsApp → Settings → Linked devices → Link a device), or ask for a pairing code for your number.',
  },
} satisfies Manifest;
