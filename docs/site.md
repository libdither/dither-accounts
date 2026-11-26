# Website: any site, kept signed in

The `site` kind keeps one website signed in, in a sandboxed browser on this machine. Use it for a site that no other
kind here knows: you give its address, sign in once, and it stays signed in. It knows nothing of the site past its
address, so it has no operations of its own. You use it in its live view, or an app or agent you approve reads and
clicks in it through the [`browser` interface](browser.md).

## Adding one

On the manager's page: **Add → Other → Any website**, with the site's address (`https://…`). Or from an app that
manages `site` accounts, with `config: { url }`. It opens that page in its own Chromium. Then sign in:

- **In the live view**, as you would anywhere: an emailed code, a password, whatever the site asks.
- **With an account you already have here.** When the site offers "Continue with Google", the click lands on a
  chooser in the live view with your Google accounts here, instead of on Google's page
  ([signin-relay.md](signin-relay.md)). Pick one with **Link it** on (the default): the Google account's own browser
  answers, goes through Google's account chooser and Continue for you, and the site signs itself in. The next time
  the site asks, it goes ahead with no chooser at all.

## What it may reach

- The site's host and its subdomains: `https://example.com` gives `https://example.com/*` and
  `https://*.example.com/*` (a leading `www.` is dropped first). That is the extension's whole host permission, so a
  page that leaves the site can't be read, and the browser interface opens nothing outside it (403).
- A "Continue with Google" there may send Google's answer only to the address's own origin (`https://example.com`).
  A site whose sign-in comes back to another host (`www.` when you gave the bare one, or an `accounts.` host) is
  refused by the manager. Add the account with the address its sign-in comes back to.

## Status

Online once its browser and extension are up. Its layers are the browser kinds' own (display, browser, extension),
then `site` (its host) and, while one is under way, `sign-in`. It can't tell whether the site is signed in, so it never
asks you to sign in: open its live view to see.

## Sleeping

It sleeps after 30 minutes with no call, no live view open and no sign-in or app tab under way, and wakes twice a day
so the site's sign-in is used ([supervisor.md](supervisor.md) "Sleeping"). Turn on **Stay awake** to keep it running.

## Code and tests

`extractors/site`: `src/main.ts` runs the browser (statements-common's `BrowserHost`, with `origins` for the site's
patterns and `signIn` for the relay's worker), the `browser` interface (`BrowserOps`) and the sign-in relay's asking
side (`SignInAsker`). The manifest's `signIn: { siteSetting: 'url' }` tells the manager that each account's own
address is its site.

`test/signin-relay.test.ts` runs a `site` account on a fake site in its own Chromium: a linked Google account signs it
in with no click from you (Google's chooser and Continue pressed with real input), its page reads as signed in through
the browser interface, and an address off the site is refused. `test/signin-relay-unit.test.ts` checks the manager's
side: each account's own https address is its site, and nothing else.
