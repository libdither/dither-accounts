# Notifications (interface `notifications`)

What a service tells you about, as a list apps can read and clear, and events as it changes
(packages/interfaces/src/notifications.ts). Four sources speak it today:

- **GitHub** (kind `github`, [github.md](github.md)): your GitHub notifications, polled.
- **Telegram Desktop** (kind `telegram` signed in through the desktop app, [telegram.md](telegram.md)): the
  notifications it shows.
- **Bug watch** (kind `bugwatch`, [bugwatch.md](bugwatch.md)): new bugs in your own services' error files and logs.
- **The manager itself** (the built-in account `notices`, below): when one of your accounts needs you.

dither-chat's hub is the app meant to read them: it ranks them with your chats and sends the ones worth it to your
phone (its `docs/notices.md`). The manager only routes; it decides nothing about what reaches you.

```
 GitHub API ─▶ extractors/github ─┐ notify.new {notification (+urgency)}
 Telegram Desktop ─▶ extractors/telegram ─┤
 your error files ─▶ extractors/bugwatch ─┤
 the manager itself (account health) ─────┤  the built-in "notices" account
                                          ▼
                         dither-accounts manager (grant: notifications, write, accounts '*')
                                          │ events / notify.list / notify.markRead
                                          ▼
              dither-chat hub: store → triage (urgency prior + its own judgement + your marks) → push
                                          ▼
                    phone / browsers / open pages
```

## The interface

- `notify.list { unreadOnly?, since?, limit?, pageToken? }` → `{ notifications, next }`, newest first, a page at a time.
- `notify.markRead { ids }`, `notify.markAllRead { before? }`: read, at the source too.
- `notify.mute { id }`: no more about what that one is about (a GitHub thread; for the manager's notices, the account).
- Events: `notify.new { notification }` (new, or back unread: apps upsert by id) and `notify.read { ids }` (read
  anywhere, by anyone). Plus the account's `hello` and `status`, as every interface has.

A `Notification`:

```ts
{
  id: string;              // the source's own, stable
  source: string;          // 'github', 'Telegram Desktop', 'dither-accounts'
  title: string;
  body: string | null;
  url: string | null;      // where it leads, on the web
  reason: string | null;   // why, in the source's words (mention, review_requested; attention, stopped…)
  context: string | null;  // where it belongs: a repository, a chat; for the manager's, the account's kind
  subject: { kind: string; title: string; url: string | null; state: string | null } | null;
  actors: { name: string; url: string | null; avatar: string | null }[];
  at: number;              // ms since the epoch
  unread: boolean;
  urgency?: 'high' | 'normal' | 'low';
}
```

### Urgency

The source's own hint of how soon you should look; never a decision, which is the app's.

| urgency | meaning | examples |
| --- | --- | --- |
| `high` | act soon | a security alert; an account that stopped or needs you; a passkey approval nobody can answer |
| `normal` | addressed to you | a mention, a review request, an assignment, a reply on what you opened |
| `low` | ambient | activity on what you only watch, CI, state changes |

Absent means `normal`. It was added to version 1 as an optional field, so the interface stays at version 1: an app
that does not know it reads everything as `normal`, which is what absence means anyway. GitHub sets it from its
`reason` (the table is in [github.md](github.md)); Telegram Desktop does not (a chat message is `normal`).

## The manager's own notices (the `notices` account)

Every manager has one account of kind `notices`, id `notices`, label `dither-accounts`, made at start when it is
missing (packages/manager/src/notices.ts). It is part of the manager: never started as a process, always online, no
live view, and neither the page nor an app can restart, disable or remove it (409 on the page, `denied` for an app).
The page lists it among the accounts, "Part of the manager". Apps see it like any account their grants cover: an app
with `notifications` on all accounts (`accounts: '*'`) gets it in its list and its events; one without hears nothing.

Its operations are answered by the manager instead of an extractor (the router's last handler), after the same grant,
input, rate-limit, audit and dry-run checks; its events go out through the same path as an extractor's, so grants,
waiting for an absent app, and gaps work the same.

What it says, each under an id stable per account and condition, so a repeat replaces rather than adds:

| id | when | urgency | title, body |
| --- | --- | --- | --- |
| `attention:<account>` | its status has been `attention` or `error`, with an `attention`, for 2 minutes | high | "<label> needs you", what the attention's kind means (below) |
| `stopped:<account>` | enabled, not running, with an error (its directory locked by another process, no extractor), for 5 minutes | high | "<label> stopped", "It is not running: its page on the manager says why." |
| `no-device:<account>` | a passkey approval asked of a device that is not paired here (outcome `no-device`) | high | "<label>: no device for a passkey approval", the site |
| `crashing:<account>` | its extractor ended on its own 3 times in 10 minutes | normal | "<label> keeps restarting" |

- `url` is the account's page on the manager (`<public URL>/#/accounts/<id>`) when the manager has a public URL
  (`--public-url`), else null. `context` is the account's kind; `reason` the condition; `subject` `{ kind: 'account',
  title: <label>, url, state: <condition> }`; `actors` empty.
- **Read again on its own** when the condition goes: the attention cleared (the account online and saying no
  attention), the account running, disabled or removed, or 10 quiet minutes after crashes. That is a `notify.read`, as
  if you had read it. A condition that cannot be told (an account whose extractor is not connected yet) changes
  nothing. A `no-device` notice stays until it is read.
- **At most once per 30 minutes** for each id: a flapping account (an attention that comes and goes) is announced again
  only when 30 minutes have passed since the last time and the condition still holds. Once announced, an id is not
  announced again while its condition lasts, also after a restart of the manager (a notice kept from before it, read
  or unread, is that episode's).
- **An outage is not "needs you"**: an attention beside a passing state (`connecting`, `offline`: "Cannot reach
  Telegram… trying again in 30 s") is not announced, and ends an episode. Only `attention` and `error` count.
- **`notify.mute { id }`** mutes that notice's account for 24 hours: nothing about it is announced meanwhile; a
  condition still there afterwards is announced then. `notify.markRead`, `notify.markAllRead` set `unread` and send
  `notify.read` for those that were unread. `notify.list` takes `unreadOnly`, `since` (at or after), `limit` (up to
  200) and the `pageToken` it gave (an offset).
- **Kept**: the last 200 in the manager's registry (table `notice`: id, account, condition, the Notification as JSON,
  unread, when last announced) and the mutes (table `notice_mute`). This is the manager's own state, not an account's
  data.
- **Nothing secret**: only the manager's words, the account's label (one line, at most 80 characters) and kind, and a
  site's domain. **Never an extractor's own text**: an attention's message can carry Telegram's two-step password hint,
  a login or pairing code, a phone number or a raw error, and a notice goes to apps and on to phones. The body says what
  the attention's kind means: `login` "It needs you to sign in again: open its page on the manager.", `verify` "It asks
  you to confirm a sign-in…", `link_device` "It waits to be linked with your phone…", else "It needs you…" (or "It
  reports an error…" for `error`); a stopped account's error stays on the page. Never a token, an account number, a
  balance or a message.
- An approver request waiting for a paired device is not a notice: the approver's own wake-up (docs/approver.md)
  reaches the phone without the hub.

### From a service on this machine

A service here can say something through the same account: `POST /api/notices/local` from this machine, never from
a browser, with the CLI token (`<data>/cli.token`, sent as `x-dither-accounts-cli`). The deployer that ships
dither-chat and this manager uses it to say what it deployed or rolled back.

```json
{ "id": "chat", "source": "deployer", "title": "Deployed dither-chat a14daa9", "body": "#162, #163",
  "url": null, "urgency": "low", "context": "dither-chat" }
```

The notice's id is `local:<source>:<id>`, so the same id again replaces it and makes it unread. It is announced at
once every time (the debounce is for flapping accounts, so the service decides how often), with `reason: "local"` and
`subject.kind: "service"`. The sweep never reads it: only an app (or you) marks it read. `notify.mute` on one mutes
that source for a day. The answer is `{ notice: id }`, or `{ notice: null }` while the notices are off or the source is
muted. Its words are the service's own, so a service must keep secrets and account data out of them.

## Tests

`test/notices.test.ts` runs a fresh manager (temp data, port 0, short hold times) with fake accounts that gain and lose
an attention, a locked directory, an extractor that crashes, and an approval for a device that is not paired; an app
with `notifications` gets `notify.new` and `notify.read`, lists, pages, marks read and mutes; an app without it gets
nothing. GitHub's urgency table is in `test/github-unit.test.ts`.
