import type { Manifest } from '@dither-accounts/manager/kinds';

/** Google Messages: SMS, MMS and RCS through your Android phone, as messages.google.com does (docs/gmessages.md). */
export default {
  kind: 'gmessages',
  name: 'Google Messages',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      'Pairs this machine with Google Messages on your Android phone, like messages.google.com: your texts (SMS, MMS and RCS) go through the phone, so it has to stay on and online.',
    fields: [
      {
        key: 'cookies',
        label: 'Google cookies (optional)',
        secret: true,
        optional: true,
        placeholder: 'leave empty to pair by QR code',
        hint: 'To pair with your Google account instead of a QR code: sign in at messages.google.com in your browser, then paste its cookies here (a "Copy as cURL" of a request to messages.google.com, a cookie export, or SID=…; HSID=…; SSID=…; APISID=…; SAPISID=…; OSID=…)',
      },
    ],
    next:
      'A QR code shows here in a moment: on the phone, Google Messages → your profile picture → Device pairing → QR code scanner. If you gave Google cookies, an emoji shows instead: tap the same one on the phone.',
  },
} satisfies Manifest;
