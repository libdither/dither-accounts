# A page that does not answer: one line in the log, for every browser kind

The browser kinds send their commands to a signed-in page through their extension: the extractor's bridge
(`packages/browser/src/bridge.ts`) → the extension's service worker → the page's content script → the page's hook.
When a command is not answered in time, the cause can be anywhere along that path. So each timeout is told apart in
the account's log as it happens, in one line:

    the Mail page's silence: request received by the page, which never answered; the hook answers without the network {…}

## What the line says

- **How far the request got** (the timeout's `reached`). The service worker says `got` (at `worker`) when it hands a
  command to the page's port, and the hook says `got` (at `page`) when the command arrives:
  - "not acknowledged by the service worker": lost between the extractor and the worker (the bridge, a worker that
    Chromium put to sleep);
  - "handed to the page, which never said it had it": lost in the page's port or content script. The content script
    replaces its port every 250 s, new one first, and keeps the old one open 10 s more, so a command the worker
    handed to the old port just then still arrives (closing it at once lost such a command now and then:
    test/port-rotation.test.ts);
  - "received by the page, which never answered": the page has it and is still working on it, or is stuck;
  - "taken by the service worker, which never answered": the statements kinds, whose worker runs commands itself.
- **The tab, as Chromium sees it** (`tab`, from the worker's `tab.state`): `status` (loading or complete),
  `discarded`, `frozen`, `active`, `audible`, the address as its origin and a path template, and how many page ports
  the worker has.
- **The page, as the hook sees itself** (`hook`, from `page.state`, which needs no network): `visibility`, `focused`,
  `wasDiscarded`, `upMs`, counts of uncaught `errors` and `rejections`, the lifecycle `events` it saw (hidden,
  visible, frozen, resumed, unloading) with their ages, and the commands it still has `open` with their ages. "The hook
  does not answer either" points at a frozen or stuck page; a hook that answers with the request still open points at
  the request itself (the site's server, or the page's own client).
- `lastAnswerAgoS`: how long since the extension last answered anything (Google: since that page did).

The worker and the hook get 5 s each to answer. Requests that time out together are one diagnosis. The hook also logs
`<command> still open after 20 s` and the page's lifecycle (`page hidden`, `visible`, `frozen`, `resumed`).

Only names of commands, path templates (segments with digits, or long ones, as `*`) and counts go in the line: never a
request's body, headers, cookies, tokens, a query, or an error's text from the page.

## Lost commands sent again

A command's id is `<boot>.c<n>`: `boot` is random per `BridgeServer`, so a page that outlives its extractor (Chromium
left running across an extractor restart) never mistakes a new command for one it already took; the content script
passes each id to its hook only once, and would drop a recycled `c1`. A bridge made with `resend` sends a command
again, the same id, when its page has not said `got` within 3 s (`RESEND_MS`), up to three times (`RESEND_MAX`); the
copy that did arrive is dropped by the content script, so a command lost on the way costs about 3 s, not the whole
timeout. Only the kinds a kind lists (`resend.kinds`, narrowed by `when`): reads, and writes that are the same done
twice (a mark read, a Gmail label). The id check lasts as long as the page: a copy that arrived just before a reload,
whose `got` was lost, would run again in the new page. So nothing that sends or posts what other people see (a
message, a post, a reply, a reaction, an edit, a delete, a Calendar event, a Proton API call other than GET) is listed,
nor the worker's own commands (every `tab.*`, meta's `mediaFetch`, privacy's `webauthn.answer`). On for google,
discord, messenger and instagram, proton, x and privacy; the statements kinds have no hook to say `got`.
A resend is logged at debug (`<kind>: no word from the page in 3 s (…); sent again (1)`), and a timeout's error carries
how often it was (`resent`).

## Chromium's own noise

Chromium's stderr goes to the account's log at debug, except lines that say nothing about the account
(packages/browser/src/noise.ts): its push registration refused (`DEPRECATED_ENDPOINT`, `QUOTA_EXCEEDED`), GTK modules
the sandbox has none of, and `X connection error received` as the display goes at a stop. Those are counted, and one
line every 10 minutes (and at the stop) says how many of each were left out.

## The parts

- `packages/browser/src/silence.ts`: `diagnoseSilence(bridge, …)` asks and logs. A `BridgeServer` made with
  `silence: { name, tab, page }` runs it on each of its timeouts by itself; Google calls it by hand, because it must
  log before it reloads the tab, per page.
- `packages/browser/src/page/worker-watch.js`, put into a service worker by its `include worker-watch` marker when
  the extension is copied (markers.ts): `workerWatch.got(sendUp, id)` after handing a command on, and
  `workerWatch.answer(sendUp, id, tabId, extra)` for `tab.state`.
- `packages/browser/src/page/command-watch.js`, put into a hook by its `include command-watch` marker after
  main-world.js: `commandWatch({ post, log, name })` once, then `const done = watch.take(p)` for each command (it says
  `got`, answers `page.state`, and starts the 20 s timer) and `done()` when the command is over. `name` turns a
  command into what a log may say (Proton: `api GET mail/v4/messages/*`; Google: `gfetch GET <host><path template>`).

## Which kinds have what

| kind | worker `got` and `tab.state` | hook `got` and `page.state` | how it runs |
|---|---|---|---|
| google (Calendar, Gmail) | yes | yes | by hand, before a reload (docs/google.md) |
| discord | yes | yes | on every timeout |
| messenger, instagram | yes | yes | on every timeout |
| proton | yes | yes | on every timeout |
| x | yes | yes | on every timeout |
| privacy | yes | its own `page.state`, with `watch` added | on every timeout |
| schwab, amazon, venmo, claude | yes (the worker runs the commands) | none: no command reaches a hook | on every timeout |

The statements kinds (schwab and the other kinds on `statements-common`) have no page-side line: their worker runs
each command itself, with `chrome.tabs` or `chrome.scripting`, so there is no hook that holds a command. Their line
says whether the worker took the command, and how Chromium sees the command's tab (`tab.state` with the command's
`tabId`, or the active tab).
