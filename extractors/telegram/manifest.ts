import type { Manifest } from '@dither-accounts/manager/kinds';

/**
 * Telegram accounts through mtcute, a pure-TypeScript MTProto client, signed in with Telegram Desktop's app or your
 * own (docs/telegram.md). With DITHER_TELEGRAM_DESKTOP=1 in the manager's environment, the add form also offers the
 * sign-in through Telegram Desktop itself, running in the account's sandbox with a live view; off by default.
 */
export function telegramManifest(desktop: boolean): Manifest {
  return {
    kind: 'telegram',
    name: 'Telegram',
    interfaces: desktop ? ['chat', 'notifications', 'desktop'] : ['chat'],
    entry: 'src/main.ts',
    add: {
      blurb: desktop
        ? "Signs in to Telegram as you. Either here, by a QR code as another device the way Telegram Desktop does, or through Telegram Desktop itself, running in this account's sandbox: you sign in with Telegram's own screens in the live view, and the app stays there, its notifications, links and saved files routed to this account. By QR code it signs in with an app of your own (api_id and api_hash from my.telegram.org → API development tools), as Telegram's terms ask, or with Telegram Desktop's published app if you choose it. Only the session is kept; a two-step password never is."
        : "Signs in to Telegram as you, as another device the way Telegram Desktop does. It signs in with an app of your own (api_id and api_hash from my.telegram.org → API development tools), as Telegram's terms ask, or with Telegram Desktop's published app if you choose it. Only the session is kept; a two-step password never is.",
      fields: [
        ...(desktop
          ? [{ key: 'signIn', label: 'Sign in with', optional: true, placeholder: 'empty: a QR code on this page', pattern: '^(qr|desktop)$', hint: "desktop: Telegram Desktop in a live view, with Telegram's own sign-in; qr or empty: a QR code here" }]
          : []),
        {
          key: 'app',
          label: 'App',
          optional: true,
          placeholder: 'own: your api_id and api_hash',
          pattern: '^(own|desktop)$',
          hint: "own: an app of your own from my.telegram.org, as Telegram's terms ask; desktop: Telegram Desktop's published app, with no my.telegram.org step, which Telegram may treat as one client posing as another",
        },
        { key: 'apiId', label: 'api_id', optional: true, placeholder: 'from my.telegram.org', pattern: '^\\d{3,12}$', hint: 'the number my.telegram.org shows as App api_id' },
        { key: 'apiHash', label: 'api_hash', secret: true, optional: true, placeholder: 'from my.telegram.org', pattern: '^[0-9a-fA-F]{32}$', hint: 'the 32 letters and digits my.telegram.org shows as App api_hash' },
        { key: 'testDc', label: "Telegram's test servers", optional: true, placeholder: 'leave empty', pattern: '^(yes|no)$', hint: 'yes, for a test account on the test DCs (numbers 99966XYYYY); otherwise leave it empty' },
      ],
      next: desktop
        ? 'With a QR code: it shows here in a moment; on your phone, Telegram → Settings → Devices → Link Desktop Device. Through Telegram Desktop: open the live view and sign in there (its QR code, or your phone number). If the account has a two-step password, this pane asks for it too.'
        : 'A QR code shows here in a moment: on your phone, Telegram → Settings → Devices → Link Desktop Device. If the account has a two-step password, it asks for it next.',
    },
  };
}

export default telegramManifest(process.env.DITHER_TELEGRAM_DESKTOP === '1');
