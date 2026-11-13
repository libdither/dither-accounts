import type { Manifest } from '@dither-accounts/manager/kinds';

/** Njalla's DNS through its JSON-RPC API with one API token (docs/njalla.md). */
export default {
  kind: 'njalla',
  name: 'Njalla',
  interfaces: ['dns'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "Your Njalla domains' DNS records, for apps (and the command line's scripts/dns.ts) to read and change. It needs an API token: " +
      'njal.la → Settings → API → Add token. Restrict it there to the domains it may touch if you like. It only lists, adds, changes ' +
      'and removes records: it never registers, renews or transfers a domain, and never makes tokens.',
    fields: [
      {
        key: 'token',
        label: 'API token',
        placeholder: 'from njal.la → Settings → API',
        secret: true,
        pattern: '^[A-Za-z0-9]{16,}$',
        hint: 'the token Njalla shows once when you add it (letters and digits)',
      },
      {
        key: 'zones',
        label: 'Only these domains (optional)',
        placeholder: 'example.com, example.org',
        optional: true,
        pattern: '^\\s*[A-Za-z0-9.-]+(\\s*,\\s*[A-Za-z0-9.-]+)*\\s*$',
        hint: 'a comma-separated list; empty means every domain the token reaches',
      },
    ],
    next: 'It checks the token now by listing your domains; they show here.',
  },
} satisfies Manifest;
