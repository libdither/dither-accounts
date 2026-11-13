# GitHub (kind `github`)

Your GitHub notifications as the `notifications` interface (packages/interfaces/src/notifications.ts): a list apps
can read and clear, and `notify.new` / `notify.read` events as they come and go. dither-chat's triage is the first app
meant to use it. It talks to GitHub's REST API directly with a token you paste: no browser.

## Adding it

On the manager's page, **Add → GitHub**:

- **Classic token** (secret). GitHub's notifications API takes only *classic* personal access tokens (or OAuth app
  tokens); fine-grained tokens and GitHub App tokens cannot read notifications, and the form turns them away. Make one
  at github.com → Settings → Developer settings → Personal access tokens → **Tokens (classic)** with:
  - `notifications`: needed (`repo` alone also reads notifications);
  - `repo`: optional. Without it the issues and pull requests of *private* repositories are not fetched, so their
    notifications come with a link but no state, author or text.
  - No expiry, or a long one: when it expires the account says so and needs a new one.
- **API URL** (optional): only for GitHub Enterprise Server, `https://<host>/api/v3`. Empty means `https://api.github.com`.

It checks the token right away (`GET /user`): the account pane shows who it is, the scopes the token has, and what is
missing in plain words if it cannot read notifications. Scopes added to the same token on GitHub are noticed within a
minute; a new token is picked up from `secret.json` without a restart (an app that runs GitHub accounts can replace it
with `admin({ do: 'secret' })`; on the page today, remove the account and add it again).

Notifications that were already unread when it was added are **not** announced: apps read them with `notify.list`.
Only what arrives afterwards comes as `notify.new`.

## How it works

```
token → GET /user (who, X-OAuth-Scopes) → poll GET /notifications → notify.new / notify.read
```

- **Polling as GitHub asks.** Never sooner than `X-Poll-Interval` (60 s on github.com), with `If-Modified-Since` set
  to the last `Last-Modified`: when nothing changed GitHub answers `304`, which does not count against the rate limit.
  On a change it reads pages (50 a page, by `Link`) only as far back as the newest update it had seen.
- **Reads elsewhere.** Every 5 minutes (`DITHER_GITHUB_RECONCILE_MS`) it reads the whole unread list without
  `If-Modified-Since` (up to 20 pages, 1000 threads): threads that were unread and are gone were read (or marked done)
  somewhere else, and become `notify.read`. A complete list also says so on any change when everything unread fits on
  one page. Threads marked unread again on the web come back as `notify.new`.
- **What `notify.new` means.** A thread new to it, one unread again after being read, or one with new activity (a
  comment, a state change): the same id again with its latest state. Apps upsert by id.
- **`notify.read`** comes for every thread that stops being unread, whoever read it: the web, the phone, or an app
  through `notify.markRead` / `notify.markAllRead` (so other apps hear it too).
- **Rate limits.** Every answer's `X-RateLimit-*` is kept (the pane shows remaining and the reset). A primary limit
  (remaining 0) is waited out until `X-RateLimit-Reset`, a secondary one (403/429) for as long as `Retry-After` says,
  or at least a minute and doubling when it says nothing. Nothing is sent meanwhile: polling waits, and operations fail
  at once with status 429 so an app can come back later. 5xx and no answer are tried again, waiting 5 s, doubling up to
  five minutes.
- **A notification** (`Notification`): `id` is GitHub's thread id; `title` the subject's title; `reason` GitHub's
  (`mention`, `review_requested`, `assign`, `comment`, `state_change`, `ci_activity`…); `context` the repository's full
  name; `subject.kind` GitHub's subject type in snake case (`issue`, `pull_request`, `release`, `commit`,
  `discussion`, `check_suite`…); `url` the web page, at the latest comment's anchor when there is one
  (`#issuecomment-…`); `at` the thread's `updated_at`.
  - Links come from the API URLs without a request (`/repos/o/r/pulls/7` → `…/o/r/pull/7`, GitHub Enterprise
    included, from the repository's `html_url`).
  - An issue, pull request or release is fetched for its `state` (`open`, `closed`, `merged`, `draft`, `prerelease`,
    `published`), its author and its description: once per change of the thread, revalidated with its ETag (an
    unchanged one is a free 304). The latest comment is fetched once for its author (`actors`) and text (`body`, up to
    2000 characters). At most 30 fetches a poll and 20 a `notify.list` page, none while the rate limit is under 10 %
    of what it allows, none for private repositories without `repo`, and none again for an hour for something GitHub
    said is gone; what is not fetched still has its link, with `state`, `body` and `actors` empty.
- **Operations.** `notify.list` → `GET /notifications` (`all=true` unless `unreadOnly`; `since`; `limit` up to 50, GitHub's
  most); `next` is a token for the next page made from GitHub's `Link` (only its query, so it cannot lead anywhere
  else). `notify.markRead` → `PATCH /notifications/threads/{id}` for each (four at a time; the ones that worked are read
  even if others failed, and the call says how many did not). `notify.markAllRead` → `PUT /notifications` with
  `last_read_at` (without `before`, GitHub's own now, so this machine's clock does not matter). `notify.mute` →
  `PUT /notifications/threads/{id}/subscription` with `ignored: true` (it does not mark it read).

### notify.mute and `id`

The manager sends an op's input to the extractor with its own call id as `id` on top, so an input field called `id`
does not arrive (the same goes for any interface's `id` input). Until the manager keeps them apart, `notify.mute` also
takes the thread id as `thread`: `client.callRaw(account, 'notify.mute', { id, thread: id })`. Called with `id` alone
it fails with a 400 that says this.

## Status

- `self`: `handle` (login), `displayName` (name), `avatarUrl`.
- `details`: `login`, `api`, `tokenType` (classic, fine-grained, oauth, github app), `scopes`, `privateSubjects`,
  `pollIntervalS`, `lastPollAt`, `polls`, `notModified` (304s), `lastChangeAt` (GitHub's Last-Modified), `unread`,
  `tracked`, `rateRemaining`, `rateLimit`, `rateResetAt`, `limitedUntil`, `subjectsFetched`. The ones that change with
  every poll do not send a new status by themselves (at most one every ten minutes).
- `layers`: `api.github.com` (or your server's host: does it answer) → `token valid` → `scopes` → `polling` (its
  interval and unread count, or the rate limit it waits out, or the failure it retries).
- `attention` (kind `login`) only when you must act: no token, a token GitHub refuses (revoked, expired, mistyped), or
  one that cannot read notifications (no `notifications` scope, fine-grained, GitHub App), each saying what to do.

## What it stores

In the account's directory:

- `secret.json` (0600, written whole by the manager): `{ "token": "…" }`. Nothing else holds the token; it is sent only
  to the API's own origin (an absolute URL on any other host is refused), and never logged.
- `state.json` (0600, written whole): where it is: the unread list's `Last-Modified`, the newest update seen, when the
  last whole look was, and per thread `[updated_at, unread]` by id. Ids and times only, never a title or a comment.
  Read threads are forgotten after 30 days (or past 5000). Deleting it is safe: the next start takes a fresh look
  without announcing anything.
- `adapter.log`: ids, counts, statuses and GitHub's error messages.

Subjects and comments it fetched are kept in memory only (up to 2000 of each) and are gone on restart.

## Limits

- Reads elsewhere are seen within five minutes when more than 50 threads are unread (or when GitHub's `Last-Modified`
  does not move on reads, which this assumes); right away otherwise.
- `updated_at` has one-second precision: two changes to a thread within the same second are one `notify.new`.
- Past 1000 unread threads the whole look stops at 20 pages and cannot say what was read elsewhere.
- No `participating` filter on `notify.list` (the interface has none); `since` filters by last update.
- Discussions, check suites and security alerts link to their repository's discussions, actions or security page,
  since GitHub's notifications API gives no URL for them.
- Rate limit: about 60 polls an hour, nearly all 304s; each change costs a page or two, and each new issue or pull
  request up to two fetches. Well under 5000 an hour.

## Tests

`test/github-unit.test.ts` (mapping, state, scopes, the client) and `test/github.test.ts` (through a manager) run against
`extractors/github/test/fake-github.ts`, a fake of the API with 304s, `X-Poll-Interval`, `Link` paging, rate limits
(primary and secondary, with and without `Retry-After`), scopes headers, fine-grained tokens and 401s. `bun
scripts/verify-github.ts` does it end to end with a manager in its own process (ports 18540–18541). Nothing calls the
real API.

Environment for tests (all in ms): `DITHER_GITHUB_RECONCILE_MS`, `DITHER_GITHUB_SECRET_CHECK_MS`,
`DITHER_GITHUB_RECHECK_MS`, `DITHER_GITHUB_BACKOFF_MS`, `DITHER_GITHUB_SECONDARY_MS`.

## What only a real token can check

The fake follows GitHub's documentation; these are what it cannot prove:

1. A classic token with `notifications` (no `repo`) lists notifications, and `X-OAuth-Scopes` says `notifications`.
2. Whether `Last-Modified` moves when a thread is read on the web (if it does, reads are noticed at once).
3. The exact message of a 403 for a classic token without the scope, and of a fine-grained token on `/notifications`.
4. `PUT /notifications` answering 202 for many unread threads and marking them in the background.
5. `X-Poll-Interval` on github.com (60 s expected) and 304s leaving `X-RateLimit-Remaining` as it was.
