# The `browser` interface: an account's own browser, driven like a person drives it

Some jobs on a site are too small or too rare for a kind to have an operation for them, such as putting
something in a cart, looking at a page, or filling in one form. For those, a browser kind can lend its signed-in
browser through the `browser` interface (`packages/interfaces/src/browser.ts`). An app or agent then opens a tab
on the account's site, reads it, and clicks and types in it, as the owner would in the live view.

It is offered today by the extension-only browser kinds on `statements-common`: `amazon`, `venmo` and `schwab`, and
the general `site` kind ([site.md](site.md)), whose whole use it is (`extractors/statements-common/src/browser-ops.ts`,
plus `extension/browser.js` appended to their driver). Another
kind built on `BrowserHost` gets it with three lines: a `BrowserOps` beside its host, `browserOps.handle(cmd)` in
its `onCommand`, and `'browser'` in its manifest's and hello's `interfaces`.

## What it does

| op | level | |
|---|---|---|
| `browser.tabs` | read | the tabs this interface opened, newest first |
| `browser.read` | read | the page's text and its interactive elements, each with a ref (`e1`, `e2`…) |
| `browser.shot` | read | a PNG of the account's display, with the tab in front: what the live view shows |
| `browser.open` / `browser.go` | write | load a URL of the account's site, in a new tab (in front) or in one of its own |
| `browser.click` | write | a real mouse click on an element, then wait for a page it loads |
| `browser.type` | write | click a field and type into it with real key presses (`clear`, `enter`) |
| `browser.select` | write | pick a `<select>`'s option |
| `browser.key` / `browser.scroll` | write | key presses (xdotool names), or about a screen of scrolling |
| `browser.close` | write | close one of its tabs |
| `browser.press` | manage | a click that may buy, pay, send or delete |

Every answer to a write says where the tab is now (`url`, `title`) and carries `challenge` when the page asks for
something only a person may give.

## How it stays a person's browser

- **Real input.** The extension only reads the page and says where an element's middle is on the screen. The
  extractor owns the account's display, and it moves the mouse, clicks and types there with xdotool. So the site gets
  trusted events from an ordinary window, as it does from the owner: no synthetic events, no DevTools and no
  automation flags. The one exception is `browser.select`, which sets a `<select>`'s value and fires its input and
  change events, because a native select's list is a popup outside the page.
- **Refs.** `browser.read` lists links, buttons, fields, selects, checkboxes and ARIA widgets that are shown, in page
  order, with their role, accessible name and value. A password field shows only whether it is filled. The refs live
  in the extension's isolated world, which the page can't see, and they hold until the next read or a page load.
  After that a ref answers 404 "read the page again".
- **Its own tabs only.** The kind's own tabs (a pull, a sign-in) are never read or touched. A tab id this interface
  didn't open answers 403. A tab left idle for 15 minutes is closed.
- **The account's site only.** A URL outside the extension's `host_permissions` answers 403. A page that leaves the
  site can't be read, because the extension has no access there.
- **One call at a time.** Two callers' clicks never interleave. While the kind is pulling, anything that would bring
  a tab forward answers 409 `busy`.

## What it won't do

- **Buy, pay, send or delete below `manage`.** A button or link whose words say so (Buy Now, Place your order, Pay,
  Send, Transfer, Delete, Subscribe…) is marked `guarded` in a read. `browser.click` refuses it, and so does a
  Return or space key pressed while it has the focus (403 `guarded`). Only `browser.press` presses it, and that op
  is at `manage`. This is best effort, going by the button's words; the grant is the real line. Give agents
  `write`.
- **Solve a challenge.** A captcha, an "I am human" checkpoint, a code by text or email or an unusual-activity page
  comes back as `challenge` and is logged. Nothing here answers one: the owner clears it in the live view. The
  kind's own pulls see the same page and hold the account as they always do.
- **Log what it reads or types.** The log names the op, the site and counts, never typed text or page contents.

## From the command line: `scripts/browse.ts`

```
bun scripts/browse.ts accounts
bun scripts/browse.ts --account amazon open https://www.amazon.com/dp/<ASIN>
bun scripts/browse.ts --account amazon read           # elements with refs, then the text
bun scripts/browse.ts --account amazon click e42
bun scripts/browse.ts --account amazon shot cart.png
bun scripts/browse.ts --account amazon close
```

It is an app named `browser-cli`. Its first run registers it with a request for `browser` at `write`; the owner
approves it on the manager's page for the accounts it may drive. Its token goes in
`~/.config/dither-accounts/browser-cli.json`. A challenge prints `CHALLENGE` and exits 3.

## Tests

`extractors/amazon/test/browser.test.ts` runs the interface against the fake Amazon's product page. It checks that a
URL off the site is refused, that the elements and their refs come back from a read, and that a select, typing and
a real click (`isTrusted`) add to the cart. It also checks that Buy Now is refused to `browser.click`, that a stale
ref is caught, that the screenshot is a PNG, and that a closed tab is gone.
