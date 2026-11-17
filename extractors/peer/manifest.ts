import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * A chat account that another manager holds, seen through it as one of its apps (docs/peer.md). The other manager's
 * grant decides what this one may do; `level` caps it here as well (read by default).
 */
export default {
  kind: 'peer',
  name: "Another manager's account",
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb: "A chat account from another dither-accounts manager, through that manager's own grants. This one asks the other for access; you approve it there.",
    fields: [
      { key: 'url', label: 'Other manager', placeholder: 'http://127.0.0.1:8486', pattern: '^https?://\\S+$', hint: 'its address, like http://127.0.0.1:8486' },
      { key: 'account', label: 'Account there', placeholder: 'acc_…', pattern: '^\\S+$', hint: "the account's id on the other manager" },
      { key: 'level', label: 'At most', placeholder: 'read', optional: true, default: 'read', pattern: '^(read|write|manage)$', hint: 'read, write or manage' },
    ],
    next: 'It asks the other manager for access to that account. Approve the request on its page; until then it says it waits.',
  },
} satisfies Manifest;
