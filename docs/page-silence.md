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
    swaps its port every 250 s; until 2026-11 it closed the old one before opening the new, and a command the worker
    sent in that moment was lost this way (now the old port keeps listening for 10 s after the new one opens);
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
