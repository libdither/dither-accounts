import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Any website, by its address, in a sandboxed browser (packages/browser, extension only; docs/site.md): you sign in once
 * in its live view, or with an account you already have here ("Continue with Google", docs/signin-relay.md), and use it
 * there or through the `browser` interface. It knows nothing of the site past its address: no operations of its own.
 */
export default {
  kind: 'site',
  name: 'Website',
  interfaces: ['browser'],
  entry: 'src/main.ts',
  // Each account's own site (its `url`) is where a "Continue with Google" there may send the answer.
  signIn: { siteSetting: 'url' },
  add: {
    blurb:
      "Any website in a sandboxed browser on this machine, kept signed in: you sign in once in its live view, or with a Google account you already have here when the site offers \"Continue with Google\". Use it in the live view, or let an app or agent you approve read and click in it (the browser interface). It stays on that site.",
    fields: [
      {
        key: 'url',
        label: 'Address',
        placeholder: 'https://example.com',
        pattern: '^https://[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(:[0-9]{1,5})?(/[^\\s]*)?$',
        hint: 'The page it opens; that site, and its subdomains, is all it may visit',
      },
    ],
    next: 'Open its live view and sign in to the site. A "Continue with Google" there offers your Google accounts here.',
  },
  // Used now and then: asleep in between (docs/supervisor.md "Sleeping"); woken twice a day so the site's sign-in is used.
  sleep: { idleMinutes: 30, keepAliveHours: 12 },
} satisfies Manifest;
