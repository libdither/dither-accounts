import type { Manifest } from '@dither-accounts/manager/kinds';

const PROVIDERS = 'proton (Proton Mail through Proton Bridge), fastmail, gmail, icloud, or custom';

/**
 * Any IMAP mailbox, with SMTP to send (docs/mail.md). The form has no choices, so the provider is a field: its preset
 * fills the servers, and the server fields (for custom, or to override a preset) stay empty otherwise.
 */
export default {
  kind: 'imap',
  name: 'Email (IMAP)',
  interfaces: ['mail'],
  entry: 'src/main.ts',
  add: {
    blurb:
      'Any mailbox over IMAP, sending over SMTP: Proton Mail through Proton Bridge, Fastmail, Gmail and iCloud with an app password, or your own server. It keeps only the password and, for Proton Bridge, the fingerprint of the certificate it saw first.',
    fields: [
      { key: 'email', label: 'Email address', placeholder: 'you@example.com', pattern: '^[^@\\s]+@[^@\\s]+$', hint: 'an address like you@example.com' },
      { key: 'provider', label: 'Provider', placeholder: 'proton, fastmail, gmail, icloud or custom', pattern: '^(proton|fastmail|gmail|icloud|custom)$', hint: PROVIDERS },
      {
        key: 'password',
        label: 'Password',
        secret: true,
        hint: 'Proton: the password Proton Bridge shows for this address. Fastmail, Gmail, iCloud: an app password (not your account password).',
      },
      { key: 'username', label: 'Username', optional: true, placeholder: 'the email address', hint: 'only if it is not the email address' },
      { key: 'name', label: 'Your name', optional: true, placeholder: 'shown in From when you send' },
      { key: 'imapHost', label: 'IMAP server', optional: true, placeholder: 'for custom: imap.example.com', pattern: '^[\\w.:\\[\\]-]+$', hint: 'a host name or IP address' },
      { key: 'imapPort', label: 'IMAP port', optional: true, placeholder: '993', pattern: '^\\d{1,5}$', hint: 'a port number' },
      { key: 'imapSecurity', label: 'IMAP security', optional: true, placeholder: 'tls, starttls or none', pattern: '^(tls|starttls|none)$', hint: 'tls (993), starttls (143) or none (this machine only)' },
      { key: 'smtpHost', label: 'SMTP server', optional: true, placeholder: 'for custom: smtp.example.com', pattern: '^[\\w.:\\[\\]-]+$', hint: 'a host name or IP address' },
      { key: 'smtpPort', label: 'SMTP port', optional: true, placeholder: '465 or 587', pattern: '^\\d{1,5}$', hint: 'a port number' },
      { key: 'smtpSecurity', label: 'SMTP security', optional: true, placeholder: 'tls, starttls or none', pattern: '^(tls|starttls|none)$', hint: 'tls (465), starttls (587) or none (this machine only)' },
      {
        key: 'certificate',
        label: 'Certificate',
        optional: true,
        placeholder: 'verify (pin for Proton Bridge)',
        pattern: '^(verify|pin|(?:[0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2})$',
        hint: 'verify, pin (trust the one seen on first connect), or a SHA-256 fingerprint',
      },
      { key: 'sentCopy', label: 'Copy to Sent', optional: true, placeholder: 'auto', pattern: '^(auto|append|server|detect)$', hint: 'auto, append, server (it keeps one itself) or detect' },
    ],
    next: 'It signs in now; its layers show where it stops if it cannot (for Proton, start Proton Bridge and sign in there first).',
  },
} satisfies Manifest;
