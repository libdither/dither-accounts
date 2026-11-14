# Google

Google accounts are signed in here, on the accounts page (https://accounts.example.net, your `--public-url`), not in the apps that use
them. There are two ways in, two kinds of account, and both answer the `google.calendar` interface
(packages/interfaces/src/google-calendar.ts) with Google's own JSON; the browser kind also reads Gmail, as `mail`
(read, marked, filed and sent from: "Gmail mail" and "Writing to Gmail" below):

| kind | extractor | how it signs in |
|---|---|---|
| `google` | `extractors/google` | **a real browser you sign in to once**, in the live view, as Discord does. The first choice. |
| `google-api` | `extractors/google-api` | an OAuth client you make in the Google Cloud console. The alternative. |

Apps such as dither-calendar ask for `google.calendar`, you approve the request on the same page, and their calls go
through the manager. No app sees a cookie or a token.

dither-calendar picks the accounts it syncs by kind: `a.kind === 'google'` (its `server/google/index.ts`). It sees
browser accounts; a `google-api` account is not picked up until it chooses by grant instead.

## Signing in with a browser (kind `google`)

On the accounts page, **Add → Google** (the kind's manifest has `add`, so the page can make the account). Its
extractor starts a sandbox, and the account says **Sign in to Google in the live view**. Open the live view, sign in as
you would on your desktop (password, second step, whatever Google asks), and leave the browser on Google Calendar.
The account goes online once a Calendar call works. The browser profile keeps the sign-in, so this is once, until
Google signs the browser out.

### What runs

- **The sandbox** (packages/browser, the Discord sandbox made general): a private Xvfb display, the first free one in
  :80–:89, then :100–:159 (no X socket, no X lock, no live claim); an ordinary, non-headless Chromium with its profile in
  `<data>/accounts/<id>/profile` and the extension copied to `<id>/extension` each start; x11vnc on
  `<id>/vnc.sock` and no TCP port, which the manager carries to the page as the live view. Deliberately not automation: no CDP, no
  `--remote-debugging-port`, no `--enable-automation`, no Playwright. The extension is the only instrument.
- **Service workers**: Chromium goes on running the extension's service worker it first registered in a profile,
  whatever the copy or the manifest's version says. So when the copied worker is not the one the last start ran (its
  hash is kept in the account's `extension-worker.sha256`), the sandbox removes the profile's `Default/Service Worker`
  before launching, never while a browser holds the profile (`packages/browser/src/worker.ts`). The sites' own service
  workers go with it and register again on the next visit; cookies and Local Storage, and so the sign-in, stay.
- **The extension** (`extractors/google/src/extension`): content scripts only on `https://calendar.google.com/*`
  and `https://mail.google.com/*`, never on accounts.google.com (the sign-in pages run nothing of ours). `hook.js` runs in the page (MAIN world),
  `content.js` relays (ISOLATED world), and the service worker holds the one socket to the extractor (a loopback,
  token-gated WebSocket; the token is in the copy's `config.json`, 0600, which the page cannot read). The worker also
  tells the extractor which page each tab is on, origin and path only (never the query or hash), with the `tabs`
  permission: that is how it knows the browser is on the sign-in page.
- **What the page can see of the hook** is kept small ([page-traces.md](page-traces.md)): `hook.js` and `content.js`
  talk by CustomEvents of this install's own types (no window messages), and the `fetch` and `XMLHttpRequest`
  wrappers read as the natives. The event types are not in the source, which has placeholders: the copy made each
  start gets names made for this install and account (`packages/browser/src/markers.ts`, from the manager's own
  secret), so no two installs show a site the same ones and none of them names us.
- **The hook** watches the page's own requests to `*.google.com` and `*.googleapis.com` (it wraps `fetch` and
  `XMLHttpRequest`) and keeps only their host, a path template with ids taken out, the `key=` API key, and the shape
  of their Authorization (which schemes, whether the hashes end in `_u`). It never keeps bodies, responses, header
  values or cookie values. It looks for API keys (`AIza…`) in the page's HTML once. It says whether the page is
  signed in (the SAPISID cookie is there) and, when the page shows it, the account's address (the account button's
  "Google Account: … (address)" label).
- **Calls**: each `google.calendar` op is the Calendar API v3 call the `google-api` extractor makes, at
  `https://clients6.google.com/calendar/v3/…?key=<key>`, made by the hook from inside the page: the page's cookies
  (`credentials: 'include'`, so the browser sends the page's Origin), `X-Goog-AuthUser`, and
  `Authorization: SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> <origin>")>`, with `SAPISID1PHASH` and `SAPISID3PHASH`
  parts when the `__Secure-1PAPISID` / `__Secure-3PAPISID` cookies exist. Cookies leave the page only as those
  hashes. No `X-Origin`: that header says the call came through Google's old cross-domain proxy iframe, and Google
  then refuses a direct call with 400 "Origin doesn't match Host for XD3".
- **The key** is found by probing (`calendarList?maxResults=1`), best first: the one that worked last time
  (`state.json` in the account's directory), keys the page's own `calendar/v3` calls use, other keys the page used or
  its HTML holds, and last Google's Calendar embed key (`AIza…`, kept in the code). If the page's own hashes end in
  `_u`, each key is tried with that form and the plain one. A 401 or 403 on a call probes again, once,
  and retries the call. A 429, a 5xx or a rate-limit 403 is retried with growing waits, honouring Retry-After. Any
  other failure reaches the app with Google's status and message (410: sync token too old).

Config (all optional): `authuser` (default 0: which signed-in Google account in that browser, as in
`/calendar/u/<n>/r` and `/mail/u/<n>/`), `mail` (default true; `false`: no Gmail tab, and `mail` answers 501),
`gmailPollSeconds` (default 60: how often the mail watch asks Gmail what changed, once a mail call was made; 0:
never), `apiBase` (default
`https://clients6.google.com`), `gmailApiBase` (default `https://gmail.googleapis.com`), `noSandbox`. `testOrigin` and
`testMailOrigin` are for tests: the start pages, the extension's matches and the hook's allowed origins then include
them. With `testOrigin` and no `testMailOrigin` there is no Gmail tab, so a test never opens the real Gmail.

### Two tabs: Calendar and Gmail

The browser has two pages, each a **role**: the Calendar tab (`calendar`, the browser's start page) and the Gmail tab
(`gmail`, https://mail.google.com/mail/u/<authuser>/), which the extractor asks the service worker to open in the
background once the extension attaches, unless the config says `mail: false`. One sign-in covers both. Both tabs are
marked not discardable, so Chromium does not drop the background one. The Gmail tab answers `mail` from
inside its own signed-in page ("Gmail mail" below), and the diagnostic, the learn runs and the self-check below.

- **Roles.** The same `hook.js` runs in both pages and says which one it is in when it comes up (from `location.host`:
  `calendar.google.com` or `mail.google.com`). The service worker keeps the role's current page, its newest port: a
  reload or a replacement takes over. Every frame a page sends up carries its role, so the extractor keeps each
  page's session, endpoints and keys apart (Calendar's key probing uses Calendar's keys only).
- **Routing.** A command carries the role it is for (`page: 'calendar' | 'gmail'`, default `calendar`), and the
  service worker sends it to that role's page only; with none open, the call fails at once ("Gmail is not open in the
  sandbox"). `gfetch` in the Gmail tab hashes the SAPISIDHASH with `https://mail.google.com`, its own origin, as the
  hook does in each page. The worker's own commands, `tab.open` and `tab.reload`, open a role's tab or send it back.
- **No cross-stalling.** Each role has its own lane in the extractor: its own queue, its own limit of requests in
  flight (Calendar 8, Gmail 4) and its own pacing (Gmail's requests at least 100 ms apart), its own silence count. A
  slow or dead Gmail tab never delays a Calendar call, nor the reverse (tested both ways).
- **Tabs in the status**: which tab is whose comes from the worker's list (each tab's role and whether our hook is in
  it), and the extractor remembers each role's tab id, so a tab sent to the sign-in page is still known as its role's.
  Before Calendar's hook ever ran, Calendar's tab is the active one, as before.

### A page that stops answering

Every request to a page is answered within **25 s** (under the manager's 30 s for an op, so the caller hears this
account's own sentence first), its time in the lane included, or the call fails with 503 and the page's name: "the
Calendar page did not answer in 25 s", "the Gmail page did not answer in 25 s".

**Two unanswered requests in a row to one page reload that page's tab, and only it**: the service worker sends the tab
back to its start page. If the page has still not answered since the last reload, the next one opens a new tab on the
start page and then closes the old one (new first: the last tab closing would end the browser). The other tab and
the browser are left alone. It is logged (`the Gmail page did not answer 2 requests in a row; reloading its tab, and
only that one`, then `the Gmail tab was sent back to its start page` or `… was reopened`) and counted in the details
(`calendarReloads`, `gmailReloads`). Requests sent to a page before its reload do not count against the new page,
nor does one cut short by its wait in the lane. After a Calendar reload, one `calendarList` call shows it answers
again; Gmail makes no call of its own, so its hook coming back up is its answer. A dead Chromium still exits for a
supervised restart, as before.

In the layers: Calendar's **Calendar API** layer is `waiting` while its page is silent ("the Calendar page did not
answer the last request in 25 s"), being reloaded, or reloaded and not yet answering, and `failed` when the tab could
not be reloaded; the account's status keeps its meaning (still `online`). The **Gmail page** layer says the same of the
Gmail tab.

### Diagnostic: does the Gmail API take the Gmail page's auth?

One question is kept in the code as a probe (`gmailApiProbe()` in `extractors/google/src/main.ts`): does the public
Gmail API v1 accept the page's first-party auth (its cookies and a SAPISIDHASH made with `https://mail.google.com`)?
It is read-only: from the Gmail tab, it GETs `https://gmail.googleapis.com/gmail/v1/users/me/profile` and
`…/users/me/labels`, each with no key and with each key the Gmail page carries (at most two: keys its own requests use
first, then keys in its HTML, found as on the Calendar page), and each with the plain and the `_u` hash. If the page
stops answering, it stops after two calls with no answer.

To ask for it, make an empty file **`probe-gmail.request`** in the account's directory
(`<data>/accounts/<id>/`). The extractor looks every 3 s, deletes the file when it takes it, and writes the answer to
**`probe-gmail.json`** there (0600), and line by line to `adapter.log` (`gmail probe: profile, key none, plain hash:
403 PERMISSION_DENIED …`). The details get `gmailProbeAt` and `gmailProbe` (a one-line summary). The answer:

```json
{
  "at": "…", "question": "…", "origin": "https://mail.google.com", "api": "https://gmail.googleapis.com",
  "page": { "tab": true, "hook": true, "signedIn": true, "keys": ["page-html"] },
  "accepted": true,
  "acceptedWith": [{ "endpoint": "profile", "key": "page-html", "auth": "plain" }],
  "results": [
    { "endpoint": "profile", "key": "none", "auth": "plain", "status": 403, "googleStatus": "PERMISSION_DENIED", "reason": "forbidden", "message": "…" },
    { "endpoint": "profile", "key": "page-html", "auth": "plain", "status": 200, "fields": ["emailAddress", "historyId", "messagesTotal", "threadsTotal"] },
    { "endpoint": "labels", "key": "page-html", "auth": "plain", "status": 200, "labels": 12 }
  ],
  "error": null
}
```

It keeps only statuses, Google's error status, reason and message (cut to 160 characters, anything like a key or an
address taken out), and for a 200 the profile's **field names** and the **number** of labels: never a value, an
address, a label's name or a key (a key is named by where it came from). `accepted` is null when nothing answered;
`error` says why the probe could not run (no Gmail tab, not signed in) or stopped.

## Learning Gmail's protocol

Gmail's web app does not use the public Gmail API (the probe above shows Google refusing the page's auth there). It
talks to mail.google.com itself, mostly POSTs under `/sync/u/<n>/i/…`, with positional JSON arrays after an XSSI
prefix (`)]}'`) and sometimes form-encoded bodies (`f.req=…`). Before the extractor can read mail that way, those
calls have to be learned from the live page. Two tools do it, and neither keeps any mail: a **shape recorder** in the
Gmail page's hook, and a **learn run** that steers the page, within fixed limits, to make the calls worth seeing.

### What the recorder keeps

In the Gmail tab only, the hook watches the page's own `fetch` and `XMLHttpRequest` calls to its own origin
(mail.google.com). For each method and **path template** (ids and numbers taken out: `/sync/u/0/i/bv` stays,
`/mail/u/0/x/abc123/` becomes `/mail/u/0/x/{id}/`; a segment is kept only if it is a short word or a one- or two-digit
number) it keeps a **count** and up to **6 distinct samples** of `{ status, contentType, requestShape, responseShape }`:
the media type without its parameters, the query and body of the request, and the body of the response, as
**shapes**. It shapes the first 40 calls of a template at most (then only counts them), keeps at most 200 templates,
does not read a body over 4 MB, a binary one, or an event stream, and reads a response from a clone, so the page's own
reading is untouched. It lives in the page's memory: a reload starts it again.

A shape holds no value. The code is `extractors/google/src/gmail-learn.js`, whose block between `learn:begin` and
`learn:end` the hook holds word for word (`test/gmail-learn.test.ts` keeps the two equal):

- **Strings** become type tags: `e` (has an `@`: an address, `Name <address>`), `h16` (16 hex digits), `d` (digits
  only), `ts` (an ISO date), `url`, `b64` (base64-like, 20 characters or more), else `s` and a length bucket: `s0`,
  `s<10`, `s<100`, `s<1k`, `s1k+`.
- **Anchors** are kept, because they say what a position means without saying anything about the mail: Gmail's
  system label ids (`^i`, `^all`, `^smartlabel_social`: `/^\^[a-z0-9_]{1,24}$/`); the kind of a thread or message id
  (`thread-f:…`, `msg-f:…`, `thread-a:…`, `msg-a:…` become `id:thread-f` and so on, never the number); and header
  names, compared without case: Message-ID, In-Reply-To, References, From, To, Cc, Bcc, Reply-To, Subject, Date,
  List-Id, List-Unsubscribe, Precedence, Auto-Submitted, Content-Type, Delivered-To, Return-Path, X-Gmail-Labels.
- **Numbers**: `true`, `false` and `null` as they are; whole numbers 0 to 64 as they are (positional enums); 13-digit
  ones `n:ms`, 10-digit ones `n:s`; anything else `n`.
- **Arrays** keep their first 40 elements' shapes, by position, and a longer one adds `len:<bucket>` (`len:<10`,
  `len:<100`, `len:<1k`, `len:1k+`). **Objects** keep keys that read as identifiers (`/^[A-Za-z_][\w.-]{0,40}$/`);
  any other key becomes `k*` (the first such key's value is shaped); past 48 keys, `k#: len:<bucket>`. Containers
  deeper than 20 levels become `…` (at 14, Gmail's message bodies and some label data were cut short).
- **Bodies**: JSON after an XSSI prefix (`)]}'` and the rest of its line, `while(1);`, `for(;;);`) is `{ json }`;
  Google's length-prefixed frames, one JSON per line, `{ chunks }`; a form-encoded body (by its Content-Type, a
  `URLSearchParams`, or how it reads) `{ form }`, each value shaped as its JSON when it parses and as a string when
  not; the query the same way; `FormData` `{ multipart }`; a Blob or buffer `{ binary: <size bucket> }`; anything else
  `{ text: <length bucket> }`.

Limits worth knowing: a key that reads as an identifier is kept, so a map keyed by names a person chose (label names,
say) would show them. Gmail's sync protocol is arrays, so its keys are its own field names, but look at the samples
before sharing them. 40 elements per array covers Gmail's long positional records; positions past the 40th are not
seen (`WIDE` in the block; raising it is safe, it shows more positions, not more values).

### The learn run

Asked for with a script, **`gmail-learn.json`** in the account's directory (`<data>/accounts/<id>/`). Write it whole
(write a temporary file and rename it): the extractor looks every 3 s, deletes the file when it takes it, and checks
the whole script before any of it runs:

```json
{ "steps": [
  { "nav": "#search/in:inbox is:read newer_than:30d" },
  { "wait": 3 },
  { "openRead": 0 },
  { "wait": 3 },
  { "back": true },
  { "wait": 2 },
  { "collect": true }
] }
```

- **`nav`**: set the Gmail page's hash. Only `#inbox`, `#all`, `#starred`, `#sent`, and `#search/<query>` where the
  query is **operators only**: every word is `op:value` with `op` one of `in`, `is`, `label`, `has`, `after`, `before`,
  `older_than`, `newer_than`, `category`, `larger`, `smaller`, and a value of letters, digits and `_ . / -`, at most 8
  of them. No bare words, no quotes, no negation, no `OR`, no `from:`, `to:` or `subject:`. Checked by the extractor
  before anything reaches the page, and again by the hook. It is sent in Gmail's own form
  (`#search/in%3Ainbox+is%3Aread`).
- **`openRead: n`**: in the thread list shown, open the n-th row (0: the first) that is **already read**, with a
  click in the middle of its subject, as a person's (pointer and mouse events: down, up, click). **An unread or
  uncertain row is never opened.** A row (`tr.zA`, on screen) counts as read only when all of its own markers agree:
  it has `yO` and not `zE`, nothing inside it has `zE`, `zF` (an unread sender) or `bqe` (a bold subject), and
  neither the row nor its sender or subject cells are drawn bold. A row with `zE` is unread; any other row (neither
  class, both, a bold part) is uncertain, and is skipped as unread is. The row is checked again just before the
  click. The answer is `{ opened: true }` once the page's address changed, or `{ opened: false, reason }` (no list
  shown, not that many read rows, the page did not open it). Opening a read thread changes nothing in it.
- **`back`**: `history.back()`, only over what this run did (a nav that moved, a thread it opened), so it never takes
  the tab out of Gmail; otherwise it is skipped.
- **`wait: s`**: 1 to 20 seconds, for the page to make its calls.
- **`collect`**: everything the page has recorded so far goes to **`gmail-shapes.json`** in the account's directory
  (0600, pretty JSON: `{ at, templates: [{ method, template, count, samples }], dropped }`, sorted by template), and
  one line to `adapter.log`: `gmail learn: collected 3 templates: GET /mail/u/0/x/{id}/ ×1, POST /sync/u/0/i/bv ×4,
  POST /sync/u/0/i/fd ×2; written to gmail-shapes.json`.

Limits, checked first: at most **12 steps**, at most **5 `openRead` steps** in a run, waits of 1 to 20 s, and every nav
as above. A bad script (not JSON, a step of another kind, a free-text search, a sixth `openRead`) is **refused and
nothing of it runs**: `gmail learn: refused, nothing ran: step 1: nav: search word 2 is not an operator (…)`. A run
needs the Gmail page up and signed in, and stops at the first step the page refuses or does not answer. Each step is
logged by its kind (`gmail learn: step 3 (openRead 0): opened`; a search as `nav to a search (3 operators)`), never a
search's words and never anything from the page. The details get `gmailLearnAt` and `gmailLearn` (a one-line summary:
`ran 7 steps; opened 1 read thread; collected 5 templates`, or `refused: …`).

What the page could notice: its `fetch` returns a promise of the hook's own (settling as the native one does) for
calls to its own origin, its XHRs get a `loadend` listener, and the clicks are synthetic (`isTrusted` false)
([page-traces.md](page-traces.md)).

### Status

The account's status (`{ status, attention, liveView: { vncSocket, width, height } | null, self?, details }`):

- **connecting** while the browser starts, while the Calendar page loads, and while keys are probed.
- **attention `login`**, "Sign in to Google in the live view": the tab is on accounts.google.com, the page says it is
  not signed in, or the browser was sent off Calendar before ever being signed in (signed out, calendar.google.com
  may send you to a Google product page rather than the sign-in page).
- **attention `api_refused`**: signed in, but every key was refused; the message lists the probes' statuses.
- **attention `unknown`**: the extension did not attach within 30 s, or Calendar is no longer open after a sign-in.
- **error**: the sandbox could not start (no free display, a binary missing).
- **online**: a probe worked.

`details` holds the session's facts, none of them secret: `provider` (`Gmail`, so a mail client knows the account
is Gmail, on a Workspace domain too), `email`, `authuser`, `display`, `page` (the Calendar tab's origin and path),
`extensionAttached`, `calendarPage`, `signedIn`, `keySource` (which kind of key won: `calendar-request`,
`page-request`, `page-html`, `embed`), `authStyle` (`plain` or `u`), `lastProbeAt`, `lastProbeStatus`,
`endpointsSeen` and `pageAuth` (the schemes the Calendar page's own calls use). For the tabs: `tabs` (which tabs
exist, by role, e.g. `calendar (hook up), gmail (hook up)`, a host where our hook is not, and how many others; no
address or content), `mail` (whether this account has a Gmail tab), `gmailTab` (its origin and path), `gmailPage`
(our hook is in it), `gmailSignedIn`, `calendarReloads` and `gmailReloads`, and the probe's `gmailProbeAt` and
`gmailProbe`, and the last learn run's `gmailLearnAt` and `gmailLearn`.

`layers` are, outermost first, `display`, `browser`, `extension`, `signed in`, `API key` and `Calendar API` (what
Calendar rests on; the last two say `interface: 'google.calendar'`, so an app reading mail is not told it stops at
them), then **`Gmail page`**, which Calendar does not rest on (it and the two Gmail layers after it say
`interface: 'mail'`): `ok` when its hook is up and signed in;
`waiting` while it opens or loads, while Google wants a sign-in, or while it does not answer or is being reloaded;
`failed` with the reason when its tab could not be opened or reloaded, or is on another site after a sign-in; `off`
with `mail: false`; and **`Gmail protocol`**: `ok` when the last calls to Gmail's endpoints were answered in the layout
known, `failed` with the endpoint and where it differs (no value), `waiting` before any mail call ("Gmail mail"
below); and **`Gmail background`**, the background lane ("The background lane" below): `ok` (`idle`, or `running`
for 30 s after a background call), `waiting` while backed off (until when), `failed` while stopped (and why), `off`
without a Gmail tab. For mail, the details also say `idPerMessage`, `summaryHeaders`, `raw`, `searchIds`,
`backgroundLane`, `backgroundStopped`, `readsMarkRead`, `bvLayout`, `canSend`, `sendNote`, `gmailWatch`,
`gmailSelfCheckAt` and `gmailSelfCheck`. The extractor's log (`adapter.log`) has ids and
statuses: never cookies, keys, tokens, queries or anything from your calendars or your mail.

### What is verified, and what is not

**Verified** by `test/google-browser.test.ts`: a real manager runs the extractor, which runs a real Chromium on Xvfb
with x11vnc and the extension, against a fake Google on 127.0.0.1 (a stand-in Calendar page that sets a SAPISID
cookie and makes calls of its own, and a Calendar API that checks the key and the SAPISIDHASH against the cookie and
origin). It shows: the extension loads unpacked and attaches; tabs are reported without query or hash; the hook sees
the page's fetch and XHR calls (template, key, `_u`) and the keys in its HTML; probing order, `_u` then plain, the
re-probe on a 403 and `state.json`; list, insert, patch and delete through `AccountsClient.call`; a 410 arriving as
410; attention `login` with a live view when there is no cookie; the VNC socket answering (and its x11vnc holding no TCP or UDP socket); nothing secret in the log
or the status; and every process gone when the manager stops. For Gmail (a stand-in Gmail page on an origin of its
own, and a Gmail API whose profile and labels want a SAPISIDHASH made with that origin): both tabs come up and the
details show both; `mail: false` opens none; the probe's answer has statuses, field names and a count and no value;
a stalled Gmail page holds up no Calendar call and a stalled Calendar page no Gmail call; a stalled Calendar page
makes each call fail within 25 s with its name, and after two its tab alone is reloaded and answers again, with the
Gmail tab not loaded again and the extractor not restarted; a stalled Gmail page is reloaded, then, still silent,
opened anew in a new tab with the old one closed. The learn run (the stand-in Gmail page has a thread list with
Gmail's row markers, unread and uncertain rows first, and calls its own /sync endpoints on load, when a row is opened
and when the hash comes back to a list, with positional JSON after an XSSI prefix full of a marker): a run goes to an
operators-only search, opens the first and second read rows only, goes back, finds no read row 9, and collects
`gmail-shapes.json` with the three templates, their counts and shapes, and no marker; a free-text search, six
`openRead` steps or a 60 s wait are refused and the page makes no call. Gmail mail (the stand-in page now sends an
XSRF header on its sync calls, syncs once on load and makes a call carrying its account key; behind its endpoints is
a fake Gmail mailbox answering in the recorded layout, test/fake-google.ts): mailboxes with their roles, the inbox
paged to its end by the cursor while a Calendar call runs beside each page, get, attachment and raw from the fake's
.eml, a search and an ids-only one, free text refused there, `mail.changes` seeing a new message, nothing written by
any of that; then through the hook's write path, read and unread, a star and off, the trash and back to the inbox,
Spam answering 501, and a reply with a file sent (the bytes handed to the page in pieces, uploaded, the draft, the
send, the original marked replied); a swapped layout refused with 502, the Gmail protocol layer failed, Calendar still online, and
ok again after; the watch's `mail.arrived` and `mail.changed`; the self-check from its file, with no subject,
address, name, label name or id in it and only one read message older than 30 days downloaded. The suite is skipped
when Xvfb, chromium or x11vnc cannot be found. `test/gmail-learn.test.ts` (no browser) covers the shapes (anchors kept, a marker in subjects,
bodies, names, addresses and keys never surviving, random inputs giving only tags and anchors), the XSSI, chunk and
form parsing, numbers, the depth cap, path templates, the nav check, the script's limits, and that hook.js holds the
same block.

**Not verified: the real Google.** Nobody has signed in (the work was done without touching a Google account), so
none of this has met Google:

- whether clients6.google.com takes cookie-authenticated Calendar API v3 calls from the calendar.google.com page at
  all (CORS for that origin, which keys it accepts, whether the Calendar API is enabled for the keys' projects), and
  whether any key qualifies: the Calendar web app may not call `calendar/v3` itself (then there is no
  `calendar-request` key), keys in the HTML may belong to other APIs, and the embed key is meant for public
  calendars;
- the `_u` form: in yt-dlp's YouTube code, the best public description, a hash ending in `_u` has a user-session id
  hashed in front of the timestamp. Calendar's equivalent is unknown, so the `_u` form here hashes the same string as
  the plain one and only adds the suffix. If Google wants the real thing, the plain form is still tried;
- whether the account button's label still reads "Google Account: … (address)" (if not, `email` stays empty; nothing
  else depends on it);
- the sign-in detection by host (accounts.google.com) and the signed-out redirect, which the test cannot reach;
- **Gmail**, all of it: whether mail.google.com opens straight into the inbox in the sandbox or shows an interstitial
  first (a welcome or smart-features screen, a "use Gmail in this browser" prompt; the hook runs there, so the layer
  would say ok); where a signed-out mail.google.com sends you (assumed: accounts.google.com, or a product page);
  whether the Gmail page carries an API key at all (its HTML or its requests) and for which API; what the Gmail API
  says to the page's auth (the probe's question); and what a second heavy page costs in memory (Gmail's tab may well
  take a few hundred MB more per account);
- **Gmail mail on the real Gmail**: everything in "Gmail mail" marked a guess or a convention, and whether Gmail
  takes the bodies built here (only the page's own were recorded), the headers replayed and the next `c`; whether
  the download route answers with the original for the key learned from the page; how `s` answers an old sync point.
  The self-check answers most of it;
- **the learn tools on the real Gmail**: whether its thread rows still carry the markers `openRead` reads (`tr.zA`,
  `zE`, `yO`, `zF`, `bqe`; if not, every row is uncertain and nothing is opened, which the reason says), whether
  Gmail opens a thread on a synthetic click, and whether all of its calls go through the page's own `fetch` and
  `XMLHttpRequest` (a call made from a worker or an iframe is not seen).

The first real sign-in answers most of it: look at the account's `details` (`pageAuth`, `endpointsSeen`, `keySource`,
`lastProbeStatus`) and the `probe: key from …` lines in its `adapter.log`, and ask for the Gmail probe once.

**If Google refuses** (attention `api_refused`): the fallback is to drive the Calendar page's own internal calls, the
ones the web app makes to list and change events, from the hook, as the Discord extractor drives Discord's client, and
map them to `google.calendar`'s v3 shapes in the extractor. That is more work and breaks when Google changes its app.
Until then, the same Google account can be connected as `google-api` (below).

## Gmail mail

The `google` kind answers the `mail` interface (`packages/interfaces/src/mail.ts`) for Gmail: mailboxes, lists, one
message whole, its attachments and original, search, and keeping up (this section); marking, filing, trashing and
sending ("Writing to Gmail", below). Spam is not written. Gmail's public API
refuses the page's auth (the probe above), so this goes the way the Gmail web app itself goes: its own endpoints on
mail.google.com, called from inside the signed-in Gmail tab, with the page's own headers. The code is
`extractors/google/src/gmail/`: `protocol.ts` (request bodies, reading answers by anchors, fingerprints, labels),
`mail.ts` (the ops), `mime.ts` (the original, parsed), `selfcheck.ts`.

What is known of the protocol comes from the shapes the learn run recorded on the live page (type tags and anchors,
never values; `gmail-shapes.json`, above). Positions that the shapes cannot explain are marked as guesses below; the
self-check (next section) settles most of them on the live account without reading anything private.

### How a call is made

- **What the hook learns from the page** (in the Gmail tab only, kept in the page, never sent up): from the page's own
  calls to `/sync/u/<n>/i/…`, the latest one's headers (names and values: Gmail's XSRF and build headers and the
  like; never cookie, host, origin, referer, user agent, content length), the query's `hl`, `rt` and `pt`, the highest
  `c`, and from its own `s` calls the sync point they start from (element [3][4] of the body, Gmail's history id); from
  its `/mail/u/<n>/` calls, the account key `ik`. `gmail.syncInfo` tells the extractor only whether a sync call was
  seen, how many headers, whether the key is known, and the sync point.
- **`gmail.sync`**: a POST to `/sync/u/<n>/i/bv`, `fd` or `s` (nothing else) as the page makes it: its headers
  replayed, `?hl=…&c=<next>&rt=…&pt=…`, a JSON body, the page's cookies; the answer's JSON after its `)]}'` prefix. An
  `s` body that carries label changes (anything at element 1, or a list inside element 0: how the page's own writes
  look) is refused in the hook, whatever the extractor sent: writes go through `gmail.write` ("Writing to Gmail").
  Until the page has made a sync call of its own: 503. The sync point the hook notes comes from the page's reading `s`
  calls only: in its writes, [3][4] holds another number (48 or 49 in every one seen).
- **`gmail.raw`**: the page's own "Download message" route, `GET /mail/u/<n>/?ik=<ik>&view=att&th=<id in
  hex>&attid=0&disp=comp&safe=1&zw` (what "Show original" → "Download original" fetches; the hex id is Gmail's message
  id, the number after `msg-f:`, in hex). Kept in the page (at most three, two minutes) and handed to the extractor in
  4 MB pieces (`gmail.rawChunk`, `gmail.rawDrop`), so a 50 MB message fits the bridge. Over 50 MB: 413.
- **Pacing**: Gmail calls one at a time per account, each at least 300 ms after the last one ended (`GmailMail`), on
  top of the Gmail page's own lane. A call is answered within 25 s (a download within 90 s), as every page request.
  Calls with `background: true` wait in a lane of their own, behind every foreground call ("The background lane").
- **An answer that is not mail** (not JSON from `bv`, `fd` or `s`; an HTML page or a 429 from the download route) goes
  up from the hook only as what it reads as (`pageKind`, in the shared learn block of `gmail-learn.js` and the hook):
  `signin` (a sign-in page, or one that ended up on accounts.google.com), `challenge` (a verification or captcha page:
  "unusual traffic/activity", "verify it's you", a CAPTCHA, Google's `/sorry/` page; or a 429 that names one), or
  nothing. Never its text: the HTML stays in the page. Such an answer is 502 in the foreground ("Gmail answered the
  page's list and search (bv) call with a verification page, not mail; open the live view") and stops the background
  lane.

### Endpoints, and how their answers are read

Answers are positional arrays. Nothing is read by position alone: thread rows are found by their **anchors** (a list
whose element 3 is a thread id, `thread-f:<n>`, and element 2 a 13-digit date in ms) wherever they are, messages by
theirs (element 0 a message id, `msg-f:<n>`, element 10 a list of label ids starting with `^`), and then each
endpoint's **fingerprint** checks they are where the recorded shapes had them, with the right types.

| call | request (as recorded) | answer: what is read | fingerprint |
|---|---|---|---|
| `bv` (a thread list for a Gmail search) | `[[reqId, 50, null, query, [… now, tz …], query, 1, n, …, [[[2, 50]]], …, [now, null, null, 18]], null, [0, 5, null, null, 1, 1, 1]]` | two layouts (below): rows at `json[2][n][0]` (**own**) or `json[19][0][1][n][0]` (**page**): [0] subject, [1] snippet, [2] date, [3] thread id, [4] messages, [19] thread id in hex; a message: [0] id, [1] `[1, address, name]` sender, [6] date, [9] snippet, [10] labels, [11] attachments; `json[4]` a 6 to 7 digit number of unknown meaning (not the estimate); `json[18][0]` a trailing number (read as the sync point, a guess); own layout only: `json[1]` the label list, `json[6][0]` the counts | `json[0]` is 0 and `json[18]` holds a number (so an empty answer is told from another kind of answer); thread rows only at `json[2][n][0]` or `json[19][0][1][n][0]`, all of them in one of the two, every entry there a row; every message passes its anchors; own layout: label entries' ids are label ids |
| `fd` (whole threads) | `[[[thread-f:<n>, 1, null, null, 1], …], 2]` | `json[1][n]`: [0] thread id, [1][1] message summaries: [0] id, [1] sender, [2] date, [3] labels | `json[0]` is 0; each entry's [0] a thread id; each summary's id, date, labels |
| `s` (what changed since a sync point) | `[[1, null, null, 0], null, [1, null, null, null, [null, 25], null, 1], [null, 1, now, 0, history], 2]` (element 1 always null: no changes) | `json[1][7]` the new sync point; `json[1][2]` the label list (`[[id, name, …, (17) type], n]`); `json[1][5][n][0][2][6][0]` changed threads, rows as bv's (their messages also carry [2] to and [5] cc); `json[2][0]` counts `[id, unread, total]` | `json[1][0]` is 0 and `json[1][7]` a number; thread rows only at `json[1][5][n][0][2][6][0]`; label entries an id and a name; `json[2][0]` a list |
| download route | `GET /mail/u/<n>/?ik=…&view=att&th=<hex>…` | the RFC 822 bytes | not an HTML page; a header line first, a blank line after the header block, and a From, Date, Message-ID, Received, MIME-Version, Subject, Return-Path or Delivered-To header in it (with no header line first, the refusal says the start's shape, never its text: empty, a blank line, a space, a byte-order mark, an mbox "From " line, markup, or a plain first line and the size). A message Gmail keeps with no headers at all downloads as a blank line, then its body: taken (no sender, subject, date or Message-ID from it; its labels and date from the listing) only when Gmail's own listing, seen since the extractor started, has it with no sender, and never with markup after the blank line |

**bv's two layouts.** The extractor was built from the page's own `bv` answer (rows at `json[19][0][1][n][0]`); the
live Gmail answers the extractor's own `bv` calls in another layout, recorded content-free (type tags and Gmail's
anchors) when the first one failed its fingerprint:

| | own (the extractor's calls, live) | page (the page's own calls, recorded) |
|---|---|---|
| `json[0]` | 0 | 0 |
| `json[1]` | the label list: `[[id, name, …, (6) 0/1, (8) [5], (11) n, (12) 0/1, (14) [n, n], (17) type, (20) 1–3, (21) 1–2, (22) 2, (23) 0/1, (24) 0/1, (27) type], n]`; for a system label the name is its id again, for yours (`^x_<n>`, type 2) a string | |
| `json[2]` | the thread rows, `[[threadRow, n], …]` | |
| `json[3]`, `json[4]`, `json[5]` | 1, a 6 to 7 digit number (not the estimate: live searches with a few dozen results carry it), 1 | the same |
| `json[6]` | `[[[id, n, n, (0 or 4)], …]]`: per label, two counts (an entry may hold its id alone) | |
| `json[11]` | `[1, n]` | `[1, 50]` |
| `json[18]` | `[n]` | `[n]` |
| `json[19]` | | `[[2, rows, 1, …]]` |

Both parse; which one answered is kept (`details.bvLayout`, the self-check's `evidence.bvLayout` and `bvLayouts`, the
Gmail protocol layer's note "… (bv in its own layout)"). The fingerprint stays strict: rows found by their anchors
anywhere else, or in both places at once, or an entry there that is not a row, is still a LayoutError (502). The type
in a label entry ([17], also at [27]) reads as: 5 system, 1 a category or smart label, 2 yours, 8 assistive, 10 one
other kind.

**On a mismatch** the call is refused, nothing is returned: **502** with a plain sentence ("Gmail's list and search
(bv) answer is not laid out as this extractor knows it (at json[2][0][0][2]: expected the row's date in ms (13
digits), got an id); nothing was returned rather than possibly wrong mail"), and the **Gmail protocol** layer goes
`failed` with the endpoint and the same `where: expected, got`. The sentence names positions and kinds of things only
(a list of 5, a number, a string, an id, a label id), never a value. A non-200 from Gmail is 502 too, and fails the
layer with its status. The next call that passes puts the layer back to `ok` ("bv, s, raw answered as expected").
Before any mail call the layer is `waiting`; with `mail: false`, `off`.

### Ids

| | | |
|---|---|---|
| message (`id`, `emailId`) | Gmail's message id, decimal (the number after `msg-f:`): the same in every mailbox, and in the download route's hex | messages the page holds that Gmail has not got yet (`msg-a:` ids, a reply being sent) are left out |
| `threadId` | Gmail's thread id, decimal (after `thread-f:`; for a `thread-a:` row, its hex id at [19]) | |
| mailbox | Gmail's label id (`^i`, `^t`, …, yours `^x_<n>`), or `all` | |
| attachment | the part's IMAP-style number in the original (`2`, `1.3`; `1` for a message that is one part), as the imap kind's | |
| `next` / `before` / `cursor` | `c1.<date ms>.<message id>`: the last message given; the next page is everything older | no server state: good for as long as the mail is |
| state | `g1.<history id>.<ms>`: Gmail's sync point and when it was handed out; one for the whole account | |

### Mailboxes, and which mappings are confirmed

| id | name | role | listed by | |
|---|---|---|---|---|
| `^i` | Inbox | inbox | `in:inbox` | shapes: on inbox rows; a system label |
| `^t` | Starred | flagged | `is:starred` | convention |
| `^t_z` | Snoozed | | `in:snoozed` | convention |
| `^io_im` | Important | important | `is:important` | convention (Gmail's IMAP name is the same idea) |
| `^f` | Sent | sent | `in:sent` | convention |
| `^scheduled` | Scheduled | | `in:scheduled` | its name says so |
| `^r` | Drafts | drafts | `in:drafts` | convention; its counts fit |
| `all` | All Mail | all | `in:anywhere -in:trash -in:spam` | ours: every message not in Spam or Trash |
| `^s` | Spam | junk | `in:spam` | convention |
| `^k` | Trash | trash | `in:trash` | convention |

**Backed by the shapes**: the sync answer's label list has exactly eleven system labels (type 5): `^all`, `^b`
(chats, not listed), `^f`, `^i`, `^io_im`, `^k`, `^r`, `^s`, `^scheduled`, `^t`, `^t_z`, which is Gmail's set of
system folders; `^all` is on nearly every message; `^u` is on messages' labels in fd and s answers, and the page's own
"mark read" write takes `^u` and `^us` off (so `^u` is unread). **Gmail's convention, which letter is which folder,
for the self-check to confirm**: `^t` starred, `^r` drafts, `^s` spam, `^k` trash, `^f` sent, `^io_im` important,
`^t_z` snoozed. Your labels are the label list's entries of type 2 (ids `^x_<n>`), named by their name there, nested
by `/` (`Work/Clients` has `Work` as its parent when there is one). Never a mailbox, whatever their type says (one
rule, `isUserLabel` in `protocol.ts`): Gmail's categories and inbox tabs (`^smartlabel_*`, `^sq_ig_*`), its assistive
labels (`^assistive_*`), and its bookkeeping (`^io_*` but Important, `^iim`, `^p_*`, `^pr_*`, `^cob_*`, `^wc_*`,
`^oc_*`, `^sub_*`, `^unsub`, `^cr`, `^afw`, `^fnas`, `^ndpp`, `^u`, `^us`, `^o`, `^b`, `^all`). Counts: `s`'s
`json[2][0]` or `bv`'s `json[6][0]`, `[id, unread, total]`; unread as given, total only when it is at least the
unread (some live entries have a total of 0 under a larger unread: read as "none given"). Which of those two numbers
is which is a **guess** (the drafts' counts fit it; the self-check's `inboxCounts` sets the inbox's beside its list).

**Without a sync point** (the page has not made its own `s` call since it loaded, and this extractor has not made one
either), the label list and the counts come from one cheap `bv` instead: the inbox's first 10 threads, whose answer in
its own layout carries `json[1]` and `json[6]`. A `bv` answer in the page's layout carries neither: then 503 ("Gmail's
label list is not known yet …"). Every own-layout `bv` answer refreshes the label names too, so a list or search
needs no extra call for them.

### What each op does

- **`mail.mailboxes`**: one `s` from the newest sync point Gmail's sync gave (ours, else the one the page last synced
  from), or with neither, one cheap `bv` (above): the system mailboxes, then your labels; counts from that answer.
- **`mail.list { mailboxId, limit (50, at most 500), before, since }`**: `bv` with the mailbox's query, 50 threads a
  window, newest first. A row holds its thread's messages; those in the mailbox (its label on the message; All Mail:
  not Spam or Trash) and older than the cursor are the window's. A full window gives only those newer than its last
  row's date (a message no newer may be in a thread the next window has), a window that is not full is the end. The
  next window asks `before:<the cursor's second + 1>` (epoch seconds), and drops what is not older than the cursor.
  `since` adds `after:` and is checked to the ms. Up to 40 windows a call. Summaries: below.
- **`mail.get { id }`**: the original from the download route, parsed (mailparser, as the proton kind parses a
  PGP/MIME body): `messageId`, `inReplyTo`, every reference, `bulk` (List-Id, List-Unsubscribe, Precedence,
  Auto-Submitted, raw, 300 characters), from, to, cc, bcc, reply-to, subject and date from its headers; text (made from
  the HTML when there is none) and HTML; attachments with part numbers. Labels, flags and thread from Gmail: as last
  seen by a list, search or sync within 2 minutes, else its thread fetched again (`fd`), else a `bv` search for
  `rfc822msgid:<its Message-ID>`; found nowhere: no labels and `seen: true`. `receivedAt` is Gmail's date, `size` the
  original's bytes. One download per call.
- **`mail.attachment { id, attachmentId }`**: the original downloaded and parsed again, the part by its number; over
  25 MB: 413.
- **`mail.raw { id }`**: the original as Gmail keeps it, `{ filename: null, mime: 'message/rfc822', base64, size }`
  (`details.raw: 'original'`); over 50 MB: 413.
- **`mail.search { query, mailboxId?, limit (50, at most 200), cursor? }`**: Gmail's own search syntax through `bv`,
  paged as `mail.list`, `{ messages, next }`. Gmail answers with whole threads; each message of a matched thread is
  kept only when the query's operators that a message's labels, date and attachments can judge (`in:`, `is:`,
  `label:`, `category:`, `has:attachment`, `after:`, `before:`, `newer_than:`, `older_than:`, negated too) match it,
  so a reply of yours in an inbox thread is not `in:inbox`; free words and other operators keep the thread's
  messages. Without a mailbox, Spam and Trash are left out unless the query names them (`in:spam`, `in:trash`,
  `in:anywhere`); with one, the mailbox's query is added and its membership checked.
  **`idsOnly: true`** (`details.searchIds: true`): **operators only**, each word `op:value` with op one of `in`, `is`,
  `label`, `has`, `after`, `before`, `older_than`, `newer_than`, `category`, `larger`, `smaller`, at most 8, no free
  text, quotes or negation (else 400, and Gmail is not asked); `{ ids, next, estimate }`, up to 500 a page (`limit`),
  the next page with `cursor: next`. `estimate` is null for now: `bv`'s `json[4]` was read as Gmail's count of matching
  conversations, but live answers carry a 6 to 7 digit number there for searches with a few dozen results (seen by the
  self-check), so it is something else, kept only as evidence.
- **Sent messages' ids.** Messages sent from the web app come with the page's own id (`msg-a:…`) in [0]; Gmail's id is at [55] in hex on
every message. A msg-a message takes its [55] id once the answer it came in has been read, and only while every
msg-f message seen agrees with its own [55] (at least 5 seen, none against). The
self-check reports the counts as `evidence.hex55`.
- **Other message id forms.** A message's [0] is any `msg-<letter>:` id (`msg-a` also comes with characters outside
  letters, digits, `_` and `-`); anything not `msg-f` takes Gmail's id from [55] as above. The self-check counts the
  forms seen in `evidence.localIdKinds` (`msg-a`, `msg-a*` for the unusual form), never the ids.
- **Background calls finish in time.** A background call waits at most 20 s for each step in the lane, and the whole
  call, waits and fetches together, ends within its op's time less 8 s (mail.list and mail.get: 52 s; mail.raw,
  mail.attachment and mail.search: 112 s); past that it answers 503 `backoff` under the manager's timeout.
- **`mail.changes { mailboxId, state }`**: without a state, the newest sync point (`g1.<history>.<now>`; see "The sync
  point" for where it comes from, and `.b` at the end when a list answer gave it). With one,
  `s` from its sync point: every thread changed since, as it is now. Their messages in the mailbox are `added` when
  dated after the state was handed out (less 5 minutes), else `changed` (flags and labels); those not in it are
  `removed` (they may never have been there: ignore ids you do not know). One answer is one batch (`more: false`). Not
  known yet: what `s` answers for a sync point Gmail no longer keeps (it is read as any answer; a layout it does not
  expect fails the fingerprint), and whether a message deleted for ever shows at all; a message older than the state
  that gains the mailbox comes as `changed`.
- **The watch** (`mail.changed`, `mail.arrived`): once a mail call was made (an account nobody reads mail from makes
  no Gmail calls of its own), `s` every `gmailPollSeconds` (config, default 60; 0: never) from where it got to
  (`gmail-watch.json` in the account's directory: the sync point and when, so a restart announces what came
  meanwhile): `mail.changed { mailboxId, state }` for each mailbox the changed threads' messages are in (Inbox and All
  Mail when the sync point moved with nothing to show), `mail.arrived { message }` for messages in the inbox, not
  sent by you, dated after the last look (less 5 minutes), each once, at most 20 a look. It waits while the Gmail page
  does not answer or is reloaded, and during a learn run, the probe or the self-check. The status's `gmailWatch` says
  when it last looked.

### The sync point

`mail.changes` and the watch need Gmail's sync point (its history id). In order: the one our own `s` last answered
(`json[1][7]`), else the one the page's own `s` last started from, else **the last `bv` answer's `json[18][0]`** (one
cheap `bv` made for it when none was seen yet); a state from that last one ends in `.b`
(`g1.<history>.<ms>.b`), and so does the watch's (`guess: true` in `gmail-watch.json`). That `json[18][0]` is a sync
point is a **guess**, tested on the way: it is not taken when it goes down from one `bv` answer to the next, or is below
a sync point Gmail's sync gave; and the first `s` from it must take it (an error or a layout it does not know is
502 there) and answer a sync point no older than it and less than a million newer. Otherwise the list answers' number
is not used again (until a restart), the call answers the honest **503** ("Gmail's sync point is not known yet: the
Gmail page has not synced since it loaded, and the number Gmail's list answers end with is not one; try again in a
minute"), and the watch starts again from a sync point that is one. Once `s` answers, its own sync point is used.
The self-check's evidence (`bvTrailerEqualsPagePoint`, `bvTrailerVsPagePoint`, `bvTrailerMonotonic`, `pointFrom`,
`sFromBvPoint`, `bvPointRefused`) settles it.

### The background lane

An app's archive reads in the background: `mail.list`, `mail.search`, `mail.get`, `mail.attachment` and `mail.raw`
take **`background: true`** (an extra input; the interface's schemas let it through), and the account says it can
(`details.backgroundLane: true`; send it only then). Background calls wait in a queue of their own, apart from the
foreground (the owner's clicks, the app's normal sync, the watch), and **never go ahead of it**: one Gmail call at a
time, a foreground one whenever one waits, so a backlog of background calls holds a foreground call up by at most the
one call already under way. The rules (`BACKGROUND` in `mail.ts`):

- **Pace**: at most one list, search, thread fetch or sync call (`bv`, `fd`, `s`) per 3 s, and one message download
  (what `mail.get`, `mail.attachment` and `mail.raw` fetch) per 2 s, each counted from the call's start; on top of the
  300 ms between any two calls.
- **Budget**: at most **2 GB** (2 × 10⁹ bytes) of messages downloaded per rolling 24 h per account, counted from the
  bytes actually fetched, by both lanes (the foreground is never stopped by it, but its downloads count). Kept per
  minute in **`gmail-reads.json`** in the account's directory (0600), so a restart does not reset it.
- **Back-off**: after a slow answer (over 10 s), a 429 or a 5xx (from either lane), or a call the page did not
  answer, background calls wait 2 s, doubling with each such answer up to 5 minutes; five good background answers in
  a row end it.
- **Stops**: a **challenge** (an answer that reads as a sign-in or verification page; any other 200 that is not what
  was asked for: no JSON from `bv`, `fd` or `s`, an HTML page from the download route; or a 403), the page **signed
  out** (the Gmail page's own signed-in state, or a 401), or the day's **quota** spent. From then on every background
  call answers **503 with code `paused`** (`StatusError(…, 503, 'paused')`: "Gmail background reading is paused: …"),
  queued ones included, and **none reaches Gmail**: nothing is retried into a stop. `details.backgroundStopped` is
  `'challenge'`, `'signedOut'` or `'quota'` until the cause clears: the quota when the 24 h window has room again;
  a challenge or a sign-out when the page is signed in and a (foreground) call is answered well again (the watch's
  look counts). Foreground calls go on as usual while Gmail answers them (a challenge page is a 502 to them).
- **Too long a wait**: a background call that cannot start within 50 s (backed off past that, or behind a long queue)
  answers **503 with code `backoff`** at once, rather than time out at the manager.

The **Gmail background** layer says which state the lane is in: `ok` (`idle`, or `running` for 30 s after a
background call), `waiting` ("backed off until 12:34:56 UTC after a slow or refused answer"), `failed` while stopped
("stopped (quota): the day's download budget is spent; resumes at 08:15:00 UTC").

### The unread guard

Reading a message here downloads its original from Gmail's "Download message" route, which is not expected to mark it
read; that is checked, not assumed. When `mail.get` or `mail.raw` downloads a message the extractor knows is unread
(`^u` among its labels as last seen), its thread is fetched again afterwards (`fd`, the page's prefetch form, as
`mail.get` already does). If `^u` is gone, Gmail marked it read: a warning is logged, **`unreadGuard: 'tripped'`** is
kept in `gmail-reads.json`, `details.readsMarkRead` becomes true, and from then on `mail.get`, `mail.raw` and
`mail.attachment` on a message known to be unread answer **409 with code `unread`** (nothing downloaded). Not
tripped, nothing changes (but the one `fd` after reading an unread message). It stays tripped across restarts until
that line is taken out of the file by hand.

**Summaries** (`mail.list`, `mail.search`, `mail.changes`' `added`, `mail.arrived`): `id` and `emailId` Gmail's message
id, `threadId` the thread's; `messageId`, `references` and `inReplyTo` from the message's [13], [14] and [15], which
only `s`'s rows carry (so `mail.changes` and `mail.arrived` have them, and list and search summaries give `null`, `[]`
and `null`); no `bulk` (`details.summaryHeaders: false`; `mail.get` has every header); `from` the row's sender; `to`
and `cc` from the message's [2] and [3] (bcc is [4], on your own sent messages), again `s`'s rows only (seen on a
message sent from here, 2026-11-13; [5], read before, is empty); `subject` the thread's; `date` = `receivedAt` = the message's date ([6]); `preview` Gmail's snippet;
`hasAttachments` from Gmail's attachment list ([11]); `size` 0 (not in the list). `flags`: `seen` = no `^u`, `flagged`
= `^t`, `draft` = `^r`, `answered` = `^io_re` (the label the page puts on a message when it sends a reply to it; a reply
sent from another client may not leave it). `labels`: Inbox, Starred, Important, Sent,
Drafts, Spam, Trash, Snoozed, Scheduled by name; yours by name (by id until the label list was seen); and at most one
category, spelled as the proton kind's: a receipt (`^smartlabel_receipt`) is `Category/Transactions` always; else the
inbox tab (`^sq_ig_i_*`) decides: `_personal` none, `_social` `Category/Social`, `_promo` `Category/Promotions`,
`_notification` `Category/Updates`, `_group` `Category/Forums`; else Gmail's classifier (`^smartlabel_social`,
`_promo`, `_notification`, `_group`; `_personal` none); else `^smartlabel_pure_notif` is `Category/Updates`.
`^smartlabel_finance`, `^smartlabel_travel`, `^assistive_*` and `^cob_sm_*` give none (yet): one table,
`CATEGORY_TIERS` in `protocol.ts`. Every other `^` id (`^all`, `^u`, `^o`, `^io_lr`, …) is Gmail's bookkeeping and left
out.

**Status details**: `provider: 'Gmail'`, `idPerMessage: true`, `summaryHeaders: false`, `raw: 'original'`,
`searchIds: true`, `backgroundLane: true`, `backgroundStopped` (null, or why the background lane stopped),
`readsMarkRead` (the unread guard tripped), `bvLayout` (`own` or `page`: the last `bv` answer's), `writes: ['seen',
'flagged', 'move', 'trash']` (no `junk`), `canSend` (the Gmail page up, signed in, its address shown) and `sendNote`
(why not, else null), `sendCap` (25 MB), `maxRecipients` (100), `gmailWatch`, `gmailSelfCheckAt` and
`gmailSelfCheck`. No storage quota (none was found in the recorded answers). `self.addresses` is the one address the
page is signed in as, with the name its account button shows.

**Guesses, in one place** (each a position the shapes show but cannot explain): `bv` request element 0 (a request
id: a random 9-digit number here), element 7 (the sync point here), the number beside the time at [0][4][12] (the
time zone's offset in ms here) and the query again at [0][5]; `bv`'s `json[4]` as the estimate; `s`'s `json[1][7]` as
the new sync point; `bv`'s `json[18][0]` as the current sync point (tested as it is used, above); the counts' order
(`s`'s `json[2][0]` and `bv`'s `json[6][0]` alike); the cheap `bv`'s page size of 10 (the page's own ask for 50); [6] as the date Gmail sorts by; rows
dated by their newest *matching* message (paging works either way as long as rows come sorted by their date; the
self-check counts rows dated after a page's `before:`); `^x_<n>`/type 2 as your labels.

## Writing to Gmail

Marking, filing, trashing and sending go the way the Gmail page itself does them: label changes and a draft's send,
each a sync call (`s`) with changes in it, made from inside the signed-in Gmail tab (`extractors/google/src/gmail/
write.ts`). They were learned on the live page on 2026-11-13: first each action done by hand in a test account's live
view while the shape recorder ran (type tags and anchors only), then the full bodies of a compose, an upload and a
send, read from the page on test messages between the owner's own accounts, and each kind of call built here sent
once on those test messages and checked in Gmail and at the other end.

### How a write is made

One sync call, `POST /sync/u/<n>/i/s`, with the page's headers and the next `c`, through the hook's **`gmail.write`**:

```
[head, [[change, …]], client, [now, <number of changes>, now, sending ? 1 : 0, 49], 2]
```

`head` is null, or `[null, null, 2]` when the call sends; `client` is `[1, <sync point>, null, null, [null, 0], null,
1]` (null when it sends). Each change is `[op, [<thread id>, detail]]`, `op` a number of ours that Gmail's answer
acknowledges: its `json[0]` is `[[[op, status, null, <sync point>], …]]`, status 0 when Gmail applied that change.

- **A label change**: `detail[6] = [add | null, remove | null, [msg-f:<id>, …], null ×9]`. The labels go on and off the
  messages listed (not the rest of their thread). The page adds what it knows of the message at [11] (its inbox tab,
  sender and category) and sometimes a time and a reason; Gmail takes the change without them.
- **A draft**: a new message, `detail[2] = [[subject, null, now, thread-a:r-<n>, [record]]]`, a thread of its own; a
  reply, `detail[1] = [record, msg-f:<the message answered>, 1, null, [now]]`, in that message's thread.
- **The send**: `detail[13] = [record, msg-f:<answered> | null, 1, null, [now]]`, the draft again with the sent labels,
  in a call whose head says it sends. A reply's send also marks the answered message replied (`^io_re` on, `^io_fwd`
  off), as the page does.
- **The record** of a message being written has 78 positions: [0] the page's id for it (`msg-a:r-<n>`, a random
  positive 63-bit number), [1] `[1, address, name, null ×6, address]` the sender, [2] to, [3] cc, [4] bcc (each `[1,
  address, name?]`), [6] the time, [7] the subject, [8] `[null, [[0, html]], null ×4, 1]` the body, [10] the labels
  (a draft's `^all ^r ^r_bt`, sent `^all ^pfg ^f_bt ^f_btns ^f_cl`), [11] the attachments, [15] In-Reply-To (the
  answered message's Message-ID; Gmail adds References), [17] the time, [51] and [76] the page's compose session
  (`s:<16 hex>|#<msg-a id>|0`), [74] 2 when sending, and the constants the page puts at [35], [36], [41], [42], [77].
  Gmail answers with the thread as it now is (`json[1][5]`): the message's record under the id the page made, [13] its
  Message-ID (Gmail's own), [14] References, [15] In-Reply-To, [55] Gmail's id in hex.
- **An attachment** goes up before the draft, as the page uploads one (the hook's **`gmail.upload`**, the bytes handed
  to the page in 4 MB pieces by `gmail.uploadChunk`): Google's resumable upload on the page's own origin, `POST
  /_/upload?authuser=<n>&dcp=asu-n` with `X-Goog-Upload-Command: start` and a protobuf in base64url (1 the draft's id,
  7 the sender, 8 each recipient, 3, 4 and 11 zero), then the bytes to the URL the answer names, with `upload,
  finalize`. The answer is a token; the draft names the file `[mime, name, size, null, f_<id>, null, 0, [], null,
  token]`, and the send names it the same way.
- After a send the page posts one more change of its own, `detail[25] = [1, <a long token>, [msg-a:…]]`, most likely
  Google's anti-abuse attestation, made by its script in the page. It is not made here: sends without it were
  delivered (a new message; a reply with an attachment and a Bcc), and their copies sit in Sent as the page's do.

The hook checks every write body again (`writeRefusal` in hook.js) and refuses anything else: label changes only with
labels from a fixed set (the ones below and your labels' `^x_<n>`), never adding `^s`, on messages Gmail has
(`msg-f:`); a draft and its send only with the draft's and the sent labels, and a send only in a call whose head says
it sends; one part per change, at most 100 changes a call.

### What each write does

| | adds | takes off |
|---|---|---|
| read (`mail.flag seen: true`) | | `^u`, `^us` |
| unread | `^u` | |
| star (`flagged: true`) | `^t`, `^ss_sy` | the other star styles `^ss_*` |
| unstar | | `^t` and every `^ss_*` |
| archive (`mail.move` to `all`) | `^a` | `^i`, `^ri_hl`, `^iim`, `^t_p`, `^t_rd`, `^us`, `^k`, `^s`, `^t_z`, `^afw` |
| back to the inbox (to `^i`) | `^i` | `^a`, `^t_z`, `^us`, `^k`, `^s`, `^pr_i_u` |
| into one of your labels (to `^x_<n>`) | the label | `^i`, `^ri_hl`, `^iim`, `^t_p`, `^t_rd`, `^us`, `^k`, `^s` |
| trash (`mail.trash`, or to `^k`) | `^k` | `^i`, `^ri_hl`, `^iim`, `^t_p`, `^t_rd`, `^us`, `^s`, `^a`, `^t_z`, `^afw`, `^pr_i_u` |

These are the page's own sets, as recorded. Your other labels stay on a message through every one, as in Gmail. A
change is a label added or taken off, so making it twice changes nothing more.

- **Ids and threads**: a write needs each message's thread. It is the one this extractor last saw the message in, or
  the caller's `threadIds` (the summary's `threadId`, beside `ids` in the same order). An id with neither is left out
  and named in `unknown`; none placed is 404. One change per thread and kind of change, at most 100 a call.
- **Answers**: `{}` when every change applied; otherwise the ids Gmail answered a non-zero status for are `refused`
  (and null in `mail.move`'s `ids`); 422 `refused` when nothing applied. `mail.move` answers the same ids (a message
  keeps its id in Gmail). A call that fails is 503 when nothing can have reached Gmail (the browser not attached, the
  page not synced yet), 504 when the page did not answer in time and 502 when Gmail's answer was not one known (both
  may have made the change; label changes are harmless to send again), and 500 when the page refused the body (an
  older extension, or a body not one of the known writes; trying again will not help).
- **Not written**: Spam (`mail.move` to `^s` is 501: Gmail's "Report spam" may report the sender to Google, and its
  call was never recorded), and nothing can be moved into Sent, Drafts, Scheduled, Chats, Starred, Important or
  Snoozed (400). `answered` is Gmail's to set (400). Deleting for ever, emptying the trash, muting, snoozing and
  filters are not made.

### Sending

`mail.send` checks the message first (`gmail/send.ts`: addresses, a text or HTML body, files of at most 25 MB
together, at most 100 recipients, a path not one of the account's own files), then: each file uploaded, a draft
saved, the send. `from` must be the address the page is signed in as (else 422 `from`). Text becomes the page's own
HTML (`<div dir="ltr">`, a `<br>` per line); Gmail makes the plain-text part itself. A reply (`replyTo`, Gmail's id
of the message answered) goes in that message's thread with In-Reply-To its Message-ID (from what this extractor
saw, else from the message's original); Gmail adds References. The answer is `{ messageId, sentId }`: the sent
message's Message-ID and Gmail's id, from the send's answer.

A draft Gmail refuses is 422 `refused`, nothing sent; a draft call that fails is 503 (nothing reached Gmail) or 502
(nothing sent, a draft may be in Drafts). Once the draft is saved, a send Gmail refuses is 422 `refused` with the
draft left in Drafts, and a send call that fails or whose answer does not say is **504** (`timeout`): it may have gone,
so the caller must not send it again unseen (the hub shows it as "may have been sent"). Nothing is retried here. The
original is marked replied only after the send is acknowledged, in a call of its own. And since the caller gives up at
the op's 120 s, nothing new starts late (`SEND_LIMITS`): no upload past 60 s, no draft past 80 s (503, nothing sent),
no send past 90 s (502, the draft left in Drafts). A file is handed to the page in pieces; a piece for an upload the
page no longer holds (it reloaded) is refused rather than started anew, and the upload checks the size it got.



A content-free check of all of the above on the live account. Make an empty file **`gmail-selfcheck.request`** in the
account's directory; within 3 s it is taken (deleted) and the check runs in the Gmail tab, then writes
**`gmail-selfcheck.json`** there (0600) and a line to `adapter.log` (`gmail self-check: ok: 14 mailboxes, inbox 50, all
mail 50, ids 37, message read; 9120 ms`); the details get `gmailSelfCheckAt` and `gmailSelfCheck`. It runs, in order:

1. what the page showed: `{ syncSeen, syncHeaders (a count), accountKey, syncPoint }` (booleans);
2. `mail.mailboxes`: `count`, `roles` (the role words found), `system`, `user`, `nested`, `withUnread`, `withTotal`,
   `unreadButNoTotal`, `source` (`s`, or `bv` when no sync point was known);
3. one `mail.list` page (50) of the inbox and of All Mail: `listed`, how many summaries have each field filled
   (`subject`, `from`, `to`, `cc`, `preview`, `threadId`, `labels`, `category`, `hasAttachments`, `seen`, `flagged`,
   `draft`), `emailIdIsId`, `messageIdNull`, and booleans `idsDecimal`, `datesInRange` (2000 to now), `newestFirst`,
   `mailboxIdAsAsked`, `next`; and **`inboxCounts`**: the inbox's two counts (as the latest answer that carried them
   gave them: `from` `bv` or `s`) beside its first 50 listed, as relations only (`equal`, `more`, `fewer`), never a
   number: `firstVsUnreadMessages`, `firstVsUnreadThreads`, `secondVsListedMessages`, `secondVsListedThreads`,
   `firstAtMostSecond`, with `present` and `listComplete` (with the list not complete, the listed are a lower bound);
4. one ids-only search, `in:inbox newer_than:30d` (up to 500): `ids` (how many), `unique`, `idsDecimal`, `next`,
   `estimate` (its type), `estimateVsIds` (`fewer`, `equal` or `more`: a count of conversations may be fewer than of
   messages) and `estimateDigits` (a history id has far more digits than last month's inbox has messages);
5. one message read whole, **only one that is already read and more than 30 days old**: chosen from a search for
   exactly `is:read older_than:30d` and checked again (`seen`, the date) before anything is downloaded; never an
   unread one. `mail.raw` (`bytes`, `sizeMatches`, `parsed`, and whether it has a Message-ID, From and Date header),
   `mail.get` (`sameId`, `sameThread`, whether it has a Message-ID, text, HTML, In-Reply-To, bulk headers; how many
   attachments, references, labels, from, to; `stillSeen`), and its thread through `fd` (how many messages);
6. `evidence`, the guesses settled: `estimateEqualsSyncPoint` (true would mean `json[4]` is the history id, not an
   estimate), `bvTrailerEqualsSyncPoint`, `sTrailerEqualsSyncPoint`, `rowsAfterCutoff` (rows dated after a page's
   `before:`), `pagingFallbacks`, `notYetGmail` (`msg-a` messages left out); `bvLayout` and `bvLayouts` (how many of
   each); and the sync point ("The sync point"): `bvTrailerEqualsPagePoint`, `bvTrailerVsPagePoint` (beside the page's
   sync point read again at the end), `bvTrailerMonotonic` (null with fewer than two `bv` answers), `bvTrailerPairs`,
   `pointFrom`, `sFromBvPoint`, `bvPointRefused` (this extractor's sentence, or null);
   and `lane`: `backgroundStopped`, `readsMarkRead`;
7. `fingerprints` per endpoint (`bv`, `fd`, `s`, `raw`): `calls`, `ok`, `failed`, `firstMismatch` (where and what
   kind, never a value); and the time each step took (`ms`).

**Never** a subject, an address, a name, a body, a snippet, a label's name or an id: each step keeps counts it made
and yes/no answers; an error keeps its status and this extractor's own sentence (anything like an address or a long
number taken out). Nothing is written to Gmail: list, search, fetch and download are reads, and the download is of a
message already read.

## OAuth with your own client (kind `google-api`)

Each Google account connected this way becomes an account of kind `google-api`; its extractor
(`extractors/google-api`) holds the token and answers `google.calendar` over Google's REST API. The sign-in is the
manager's Google provider (`packages/manager/src/providers/google.ts`), on the accounts page under **Google**.

### Making the OAuth client (once)

Google only lets software use your calendar through an OAuth client that you own. It's free and takes a few minutes.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and **create a project** (any name, e.g.
   "dither-accounts").
2. **APIs & Services → Library**: search for **Google Calendar API** and click **Enable**.
3. **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding / Audience**):
   - User type **External**, app name "dither-accounts", your address as the support and developer contact.
   - **Audience / Test users**: add your own Google address.
   - Publishing status: an app left in **Testing** gets refresh tokens that **expire after 7 days**, so you would
     have to connect again every week. To avoid that, click **Publish app** (to "In production"). A personal app
     doesn't need Google's verification: when you connect, Google shows a "Google hasn't verified this app" warning.
     That is expected. Choose **Advanced → Go to dither-accounts (unsafe)**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized redirect URIs**: `https://accounts.example.net/oauth/google/callback` (your `--public-url` + `/oauth/google/callback`).
     The accounts page shows the exact address this manager uses (`<public URL>/oauth/google/callback`, from
     `--public-url` / `DITHER_ACCOUNTS_PUBLIC_URL`). Google accepts a private address like this one: it only has to be
     reachable from your browser, not from the internet.
   - Create it, and copy the **Client ID** and **Client secret**.
5. On the accounts page, **Google**: paste the client id and secret and save, then **Connect a Google account**. Pick
   your account and allow access to your calendars. Google sends you back to the accounts page, where the new account
   appears and its extractor starts.

An OAuth client made earlier for dither-calendar works too: add the new redirect URI above to it.

### What it asks for, and what is kept where

- Scope `https://www.googleapis.com/auth/calendar` (see, change and delete events and calendars), plus
  `openid email` so the page can say which account it is. Scopes are asked per account and only grow
  (`include_granted_scopes`); when Gmail comes, connecting an account again asks for it as well
  (`/oauth/google/start?account=<id>&scopes=calendar,gmail`).
- The client id and secret: `<data>/providers/google.json`. Each account's refresh and access tokens, with the
  client they belong to: `<data>/accounts/<id>/secret.json`. Both are mode 0600, never in the registry, never in an
  API answer, never logged. The account's config (shown on the page) has only its address, Google's subject id and
  the scope names.
- Nothing from your calendars is kept here: the manager routes calls, and the app that made them keeps what it needs.

### Calls

The calendar list, making and colouring calendars, and events listed (with sync tokens), created, patched (including
one instance of a series, `<series id>_<original start>`) and deleted.

- The access token is refreshed a minute before it expires, and once more after a 401.
- A 429, a 5xx or a rate-limit 403 is retried with growing waits, honouring Retry-After.
- Any other failure reaches the app with Google's HTTP status in `CallFailed.status`: 410 means a sync token is too
  old (list everything again), 404 or 410 on a delete means it is already gone.

### When it stops working

The account shows **needs attention** on the accounts page, and apps' calls fail with status 401:

- **"Google sign-in expired; connect it again on the accounts page"**: the refresh token was revoked, or expired
  because the OAuth client is still in Testing (step 3). Use **Connect again** on that account: it keeps its id, so
  apps' grants still cover it.
- **"Google refused the client id or secret"**: the client was deleted or its secret reset. Save the new secret on
  the page (the same client id with a new secret is handed to every account and their extractors restart).

**Disconnect** revokes the grant at Google, stops the extractor, and removes the account and its directory. Apps
that used it lose it at once (dither-calendar drops its copies of those calendars).

### API (the accounts page uses these)

| | |
|---|---|
| `GET /api/providers/google` | `{ configured, redirectUri, accounts: [{ id, email, scopes }], error }` (also in `GET /api/state` as `providers.google`); `google-api` accounts only |
| `PUT /api/providers/google/client` | `{ clientId, clientSecret }` |
| `GET /oauth/google/start` | redirects to Google's consent screen; `?account=<id>` connects that account again, `?scopes=calendar,...` |
| `GET /oauth/google/callback` | Google sends you back here; you land on `/#/accounts`, or `/#/accounts?google_error=<why>` |
| `DELETE /api/providers/google/accounts/:id` | disconnect |

## Tests

- `test/google.test.ts`: the OAuth provider and the `google-api` extractor against a fake Google
  (`DITHER_GOOGLE_OAUTH_URL`, `DITHER_GOOGLE_TOKEN_URL`, `DITHER_GOOGLE_REVOKE_URL`, `DITHER_GOOGLE_API`,
  `DITHER_GOOGLE_BACKOFF_MS`; test/fake-google.ts).
- `test/gmail-mail.test.ts`: Gmail mail without a browser: the bodies built against the shapes recorded on the live
  page, the readers and their fingerprints (a swapped, a moved and a cut-down answer refused, saying where and what
  kind), the category rule (a test per tier), the operators-only check, and `GmailMail` against the fake Gmail over
  HTTP as the hook reaches it: mailboxes, every mailbox listed to its end by the cursor, a cursor kept across a new
  arrival, `since`, get/attachment/raw, search and ids-only paging with the estimate, changes and the watch, the layer
  failing and coming back, the 300 ms pacing, and the self-check's report holding nothing of the mailbox. And bv's two
  layouts (the fake answers in the own one by default; `gmail.bvLayout('page' | 'third')`), mailboxes and a sync
  point from a list answer with no sync point known (and one that is not taken), `pageKind`, the background lane
  (its pace for lists and downloads, the foreground going first past a backlog, the budget kept across a restart
  and freed a day later, a challenge of each kind, a signed-out page, back-off doubling and ending, `backoff`), and
  the unread guard tripped (a fake whose download takes `^u` off) and not. Writing: the label changes built against the
  page's own as recorded, each write's labels in the fake, writes in part (`refused`, `unknown`, `threadIds`), 404 and
  422, Spam 501 and the folders mail is not moved into 400; a send with Cc, Bcc and a file (upload, draft, send) and a
  reply (its thread, In-Reply-To, the original answered, the reply's headers in `mail.changes`); `checkOutgoing`.
- `test/google-browser.test.ts`: the `google` extractor in its real sandbox against the same fake in its `web` mode
  (config `testOrigin` and `apiBase` point at it, `testMailOrigin` and `gmailApiBase` at its Gmail side; `stall()`
  makes a page's API calls hang). The stall tests wait out the real 25 s, so the suite takes about three minutes. Skipped without Xvfb, chromium and x11vnc (found on PATH, through
  `XVFB_BIN` / `X11VNC_BIN` / `CHROMIUM_BIN`, or with `nix build`).
