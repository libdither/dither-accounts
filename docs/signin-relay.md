# Signing in with an account you already have here

A site's "Continue with Google" button can be answered by a Google account this manager already holds. Take Luma:
you click Continue with Google in the Luma account's live view, and the Google account's own browser, which is
already signed in to Google, answers it. You never sign in to Google inside Luma's browser, and Google's password and
cookies never leave the Google account's browser. Only the one-time code Google hands back moves, from one browser
to the other.

Today **Luma** and any **website** ([site.md](site.md)) ask, and **Google** (the browser kind) answers. A kind takes
part with a line in its manifest and a few lines in its extension's worker (below).

## What you see

1. In the Luma account's live view, you click **Continue with Google**. Luma opens its popup on Google's sign-in
   link.
2. That link never loads in Luma's browser. The popup shows a chooser instead: **Sign in to luma.com with Google**,
   what Luma asks Google for ("your name and picture", "your email address"), and your Google accounts here, with the
   ones that are not online greyed out.

   ![The chooser](screenshots/signin-chooser.webp)

3. You pick one. **Link it** ("use it next time luma.com asks, and go through Google's screens for me") is on by
   default. Picking with it on sets up the link: this sign-in and every later one go ahead with that account, with no
   chooser and nothing for you to press. Picking with it off forgets any link, and you answer Google yourself.
4. The Google account's browser opens the link in a tab of its own, in front. Luma's link asks Google to show the
   account picker and the consent screen every time (`prompt=select_account consent`).
   - **Linked**, and the site asks Google for no more than who you are (your name, picture and email): the Google
     account presses them itself, with real mouse clicks on its display. It clicks that account in Google's chooser
     (by its email), then Continue (or Allow). It presses nothing else, and at most six times in all.
   - Anything else Google shows (a password, a code, a "verify it's you", a chooser without this account, a site
     asking for more, such as your calendar): the Google account shows an attention after a few seconds, **Google is
     asking something only you can answer…** (or, not linked, **Google may be asking you to allow a sign-in to
     luma.com**), and you answer it in the live view. A linked sign-in keeps watching: once you are past a password,
     it still presses the Continue after it.
5. Google sends that tab to Luma's redirect address with the code. The tab is stopped before it loads that address,
   so Luma's server never sees the Google browser. The address goes back to Luma's popup, which loads it: Luma trades
   the code for its own session, as it does after any Google sign-in, and the popup closes. A first sign-in this way
   makes the Luma account.

The chooser also offers **Sign in to Google in this browser instead**, which lets the link load in that one tab as
if none of this were here, and **Cancel**.

## Starting one without the live view

You can also skip step 1. Pick a Google account under **Sign in with** in the add form (Luma, or **Any website**), and
the new account signs itself in once its browser is up:

1. The manager sets up the link, as a pick with **Link it** on does.
2. It sends the account `signin.start`. The account's browser reads the page in front for a button that signs in with
   Google: its words or its label name Google ("Continue with Google", "Sign in with Google", a "Google" button). If
   there is none, it looks for the site's own **Sign in** or **Log in** and clicks that first, up to three times.
3. It clicks the Google button with real input on its display.
4. From there it is an ordinary sign-in on a linked account: no chooser, and Google's screens are gone through for
   you.

From the command line:

```sh
bun packages/manager/src/cli.ts add luma --sign-in-with <google account id>
bun packages/manager/src/cli.ts add site url=https://example.com --sign-in-with <google account id>
bun packages/manager/src/cli.ts sign-in <account> --with <google account id>   # an account you already have
```

Each waits for the sign-in to end and says how it went. On the page's API: `POST /api/accounts` takes
`signInWith: { google: <id> }`, `POST /api/accounts/<id>/sign-in` takes `{ provider, account }`, and
`GET /api/accounts/<id>/sign-in` says how the last one went. The page's add form uses the first.

It finds what a person would click, and nothing more. These stay yours, in the live view:

- a site whose Google button is Google's own drawn one (an iframe that signs in in a popup the relay does not carry);
- a site that hides its button behind something else (a menu, a cookie banner over it);
- an account that is already signed in: it says it found nothing to press.

## How it works

```
Luma's browser                       manager                         Google account's browser
──────────────                       ───────                         ────────────────────────
tab heads for accounts.google.com
  blocked, goes to the chooser
  extractor: ask signin.choices ───▶ checks the link and the site
  chooser shows accounts      ◀───── choices, remembered one
you pick one
  extractor: ask signin.relay ─────▶ checks again ─── signin.authorize ──▶ opens the link in a new tab
                                                                          (you answer Google, if it asks)
                                                                          Google redirects to luma.com/google?code=…
                                                                          stopped before it loads
                                     checks the answer ◀── that address ──┘
  tab loads luma.com/google?code=… ◀─┘
  Luma signs itself in
```

- **The asking browser** (`packages/browser/src/page/signin-worker.js`, included in the kind's worker): a session
  block rule for each provider's authorize pages (`declarativeNetRequest`, which needs no host permission for a
  block), so not one request of the sign-in reaches Google from Luma's browser. The navigation it stops is still seen
  (`webNavigation`, the tab's update), and the tab goes to the chooser page (`signin.html`, which the sandbox adds to
  the extension's copy). The extractor (`SignInAsker`, `packages/browser/src/signin.ts`) asks the manager through its
  link's `ask`.
- **The manager** (`packages/manager/src/signin.ts`) checks every relay itself, whatever the asking extractor says:
  - the link is a provider's authorize page that answers with a code in the address (`response_type` has `code`, no
    `response_mode` but `query`, an https `redirect_uri`);
  - its `redirect_uri` is on one of the asking kind's own sites (its manifest's `signIn.sites`), so a code only ever
    goes to the site whose browser asked;
  - the answering account is enabled and of a kind that `signsIn` that provider;
  - what comes back is that redirect address, with a code or the provider's error.

  It sends the answering account `signin.authorize`, a command of the manager's own: no interface carries it, so no
  app can ask for it. A choice to remember goes in the asking account's config (`signInWith: { google: <account> }`).
- **Linked**: the manager sends `auto` only when the asking account's remembered choice (`signInWith`) is this
  answering account and the link's scopes are identity only (`onlyIdentity`: `openid`, `email`, `profile` and their
  `userinfo` forms). It sends `who` too: the answering account's email as last seen, which its chooser picks.
- **The answering browser** (`SignInAnswerer`, and the same worker code): checks the link again (and `auto` against
  the scopes again), opens it in a new tab in front with a session rule that blocks only that tab from loading the
  redirect address, and answers with the address it was stopped at. The tab closes after (never the browser's last
  one). With `auto` it asks the worker every second or so what the tab shows (`signin.look`: the worker reads the page
  through `chrome.scripting`, which needs the provider's host in the kind's manifest, `https://accounts.google.com/*`
  for Google): `choose` with where `who` is in the chooser, `consent` with where the one Continue or Allow is, or
  `other`. It presses `choose` and `consent` with xdotool on the account's display, as the
  [browser interface](browser.md) does, and leaves `other` to you. Not linked, or on `other`, the account's status asks
  you to answer in the live view. A relay waits up to five minutes.
- **Kept out of logs and statuses**: the link (its state, client and scopes ride in it) and the code. The logs name
  the accounts, the provider and the site.

## What it does not cover

- Sign-ins that answer by a **form post** (Apple's `response_mode=form_post`) or by **window messages** (Google's
  One Tap and its newer button library). The manager refuses those links and the chooser says why; "Sign in to Google
  in this browser instead" still works.
- Providers other than Google. A provider is a line in `packages/spec/src/signin.ts` (its hosts and authorize paths)
  and a browser kind that answers for it; GitHub, Microsoft or Discord would each need a browser kind of their own
  here first.
- Nothing here answers a provider's own checks: a captcha or a "verify it's you" in the Google account's live view is
  yours, as always.

## Adding it to a kind

Asking (a site with a "Continue with Google"):

- the manifest: `signIn: { sites: ['https://example.com'] }`, or `signIn: { siteSetting: 'url' }` when each account
  names its own site in its config (the `site` kind);
- a kind on statements-common's `BrowserHost` (the `site` kind): `signIn: signInConfig()` in its host options, which
  appends the worker part (`extension/signin.js`) to its driver, and a `SignInAsker` that sees the host's `onMessage`.
  That is all; the rest below is for a kind with a worker of its own.
- the worker: `/*@include signin-worker@*/`, `if (signinRelay.command(msg)) return;` first in its command routing,
  `signinRelay.start(sendUp, loadConfig().then((c) => c && c.signIn));` at its top level, and its tab reports leaving
  out `signinRelay.owns(t.id)`;
- the extractor: `signIn: signInConfig()` in the extension's config, and a `SignInAsker` whose `onMessage` sees the
  bridge's frames first.

Answering (a provider's own browser kind): the manifest's `signsIn: ['google']`, the provider's host in the
extension's `host_permissions` (for `signin.look`), the same worker lines, and a `SignInAnswerer` that takes the
`signin.authorize` command, with the account's display and email for a linked sign-in.

## Tests

`test/signin-relay-unit.test.ts` reads links and runs the manager's checks against a registry in memory: the choices,
a relay and its answer, remembering and forgetting, `auto` only for a linked account and identity scopes, the `site`
kind's own address, and each refusal (another site, an account that cannot answer, an asker that does not sign in, an
answer that is not the redirect). `test/signin-relay.test.ts` runs a Google account, Luma accounts and a `site`
account in their own Chromiums against the fake Google, whose authorize page shows a chooser and a Continue screen
that go on only for trusted input, and the fake Luma:

- a linked account signs Luma in with no click: Google's chooser and Continue are pressed with real input, Luma's
  browser never reaches Google's authorize page, and neither log holds the code or the link;
- on the chooser, a pick made with real keys (Tab, Enter on the account's display) with **Link it** on signs in, goes
  through Google's screens and is remembered;
- with **Link it** off, Google's account asks for you and nothing is pressed until the test clicks the account and
  Continue on its display, as you would in the live view;
- a `site` account is signed in the same way and lends its browser on its site only;
- an account added with **Sign in with** signs itself in. Its browser presses the fake site's own Sign in and then its
  Continue with Google, both with real input, and the Google account does the rest. An account asked to with
  `POST …/sign-in` does the same, and a Google account it cannot use is refused before anything is linked.
