import type { Manifest } from '@dither-accounts/manager/kinds';

/** Any CalDAV/CardDAV server: calendars and contacts over WebDAV (docs/dav.md). */
export default {
  kind: 'dav',
  name: 'CalDAV / CardDAV',
  interfaces: ['calendar', 'contacts'],
  entry: 'src/main.ts',
  add: {
    blurb:
      'Calendars and contacts from any CalDAV/CardDAV server (Nextcloud, Fastmail, iCloud, Radicale, Baïkal…), straight over WebDAV. It finds them from the server name, keeps up by sync tokens, and checks for changes every two minutes.',
    fields: [
      { key: 'server', label: 'Server', placeholder: 'cloud.example.com or https://dav.example.com/', pattern: '^(https?://)?[^\\s/:]+(:\\d+)?(/\\S*)?$', hint: 'a domain, or a URL like https://cloud.example.com/remote.php/dav' },
      { key: 'username', label: 'User name', placeholder: 'you@example.com' },
      { key: 'password', label: 'Password', secret: true, hint: 'an app password where the server has them (iCloud, Fastmail, Nextcloud with two-factor)' },
      { key: 'contactsServer', label: 'Contacts server', optional: true, placeholder: 'only if contacts are elsewhere', pattern: '^(https?://)?[^\\s/:]+(:\\d+)?(/\\S*)?$', hint: 'a domain or URL, only when contacts are on another server than calendars' },
    ],
    next: 'It signs in and finds your calendars and address books now; if the server refuses the password it says so here.',
  },
} satisfies Manifest;
