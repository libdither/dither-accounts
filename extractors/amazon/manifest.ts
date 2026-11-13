import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Amazon order history in a sandboxed browser (packages/browser, extension only): Your Orders and order details read
 * at a person's pace, byte for byte the files dither-finance's connectors/amazon.py wrote (docs/amazon.md). The
 * stored password answers Amazon's "sign in again" prompts; a captcha or checkpoint stops the pull for you. Read only:
 * nothing here orders, cancels or returns.
 */
export default {
  kind: 'amazon',
  name: 'Amazon orders',
  interfaces: ['statements'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Reads your Amazon order history (Your Orders and each order's details) in a sandboxed browser on this machine, once a day at a person's pace, for an app such as dither-finance. When Amazon asks for your password again the stored one answers; a captcha or a code stops the pull until you clear it in the live view. Read only: it cannot order, cancel or return.",
    fields: [
      { key: 'email', label: 'Email', secret: true, placeholder: 'the email you sign in to Amazon with' },
      { key: 'password', label: 'Password', secret: true, hint: 'typed into Amazon when it asks again; never shown' },
      { key: 'totpSecret', label: 'Authenticator secret', secret: true, optional: true, pattern: '^[A-Za-z2-7 =]{16,}$', hint: 'only if Amazon asks for an authenticator code' },
    ],
    next: 'Open its live view and sign in to Amazon once (or let the first pull do it with the password). It pulls once a day; a captcha shows up here as an attention with the live view.',
  },
} satisfies Manifest;
