# Reddit's front page, inbox and comments: the `reddit` kind

`extractors/reddit` holds one Reddit account and answers the `chat` interface (docs/chat.md) with posts and a feed,
for dither-chat's Feed page (dither-chat docs/feed.md). It covers:

- the front page, sorted New or Best;
- the inbox, as one read-only conversation;
- any post's or comment's thread, its comments as a tree;
- anyone's profile, with their karma, cake day and recent posts and comments;
- when asked: upvoting and clearing a vote, commenting, posting a text post, and deleting your own.

Reddit's API wants an approved app now, so this kind is not an app. It runs **old.reddit.com** signed in, in a
sandboxed browser on this machine (packages/browser: Xvfb, Chromium, live view, as for X, Discord, Google and
Proton). Every read and write is a request old reddit's own page makes, made from inside that page with its own
cookies and token.

## Adding it, and what you do

On the accounts page, **Add → Reddit** (no fields). Its sandbox starts on old.reddit.com, which sends a signed-out
browser to Reddit's sign-in page, and the account says **Sign in to Reddit in the live view** (attention `login`, with
the live view). Open the live view and sign in as on your desktop. Any code, captcha or "is this you" check Reddit
shows is yours to answer: nothing here answers one. A check page is reported as attention `verify`.

Reddit's sign-in may leave the browser on its new site (www.reddit.com). After five seconds there, the extractor sends
it back to old.reddit.com, at most once every two minutes. If it still is not there 30 s later, the account asks you
to go there in the live view. The account goes online once old.reddit.com shows you signed in.

## What the page asks Reddit

The hook (`src/extension/hook.js`, MAIN world at document_start) reads old reddit's `r.config`: `logged` is the
username, and `modhash` is the page's token for writes. The modhash never leaves the page. The hook adds it to a write
as `uh`, the way old reddit's `$.request` does. The hook lets through only these requests, only on old.reddit.com, and
always with the page's cookies (`credentials: 'same-origin'`):

| what | request | when |
|---|---|---|
| the inbox | `GET /message/inbox.json?mark=false&raw_json=1&limit=25` | 30-60 s after online, then every 4-8 minutes |
| the front page | `GET /new.json` (Following) or `/best.json` (For you), `raw_json=1&limit=<n>[&after=<t3_…>]` | `home`, when asked |
| a post's thread | `GET /comments/<id>.json?raw_json=1&sort=confidence` | `post`, when asked |
| a comment's thread | `GET /comments/<post>/_/<comment>.json?raw_json=1&sort=confidence&context=8` | `post` with a `t1_` id |
| which post a comment is under | `GET /api/info.json?id=t1_…` | only for a comment not seen since the start |
| more comments | `POST /api/morechildren` (`link_id`, `children` up to 100, `sort`, `limit_children=false`, `api_type=json`) | `post` with a cursor ("load more comments") |
| a profile | `GET /user/<name>/about.json`, then `/user/<name>/overview.json?limit=25` | `profile`, when asked |
| upvote, clear vote | `POST /api/vote` (`id`, `dir` 1 or 0) | `postAct` like, unlike |
| comment | `POST /api/comment` (`thing_id`, `text`, `api_type=json`) | `publish` with `replyTo` (a `t3_` or `t1_`) is a comment. Without it, it is a new **text post**, and it needs `title`
(at most 300 characters) and `place`, the subreddit's bare name (`rust`; `r/rust` is taken too). A post may be its
title alone. `title`, `place` and `warning` are the protocol's `publish` fields for posts with titles and places, as
dither-chat's hub sends them. Reddit has no content warning, so a `warning` is refused. Text is checked against
Reddit's own limits before anything is sent: 10,000 characters in a comment, 40,000 in a post's body (graphemes, as
`POST_RULES` counts). Not offered: quoting, reposts and crossposts (the hub never asks), "who can reply", pictures and
video (`postMedia`), and link posts. Nobody is named for an upvote, so the hub never asks who voted.
A comment Reddit made but did not describe is never answered as failed: you are told to look on Reddit before
commenting again.

## Capabilities

`liveView` always. Once signed in on old.reddit.com it adds `home`, `posts` and `profile`, and, with the page's modhash,
`postActions`, `publish` and `unpublish`.

## Status

The status layers are display, browser, extension, signed in (`as u/name`), page and inbox:

- **page:** old.reddit.com with its modhash. Without one it reads but does not write, and this layer fails.
- **inbox:** the items announced and when it last read, or the last error.

## Tests

- `extractors/reddit/test/map.test.ts`: the mapping, against invented data in Reddit's shapes (`test/fixtures.ts`).
- `extractors/reddit/test/status.test.ts`: the status.
- `test/reddit-browser.test.ts`: the end-to-end run. A real manager runs the kind, in a real Chromium on Xvfb with its
  extension, against `test/fake-reddit.ts`, a fake old.reddit.com that records every request. It checks:
  - signed out: sign-in attention, nothing read;
  - after signing in: online, and the inbox as the feed, read with `mark=false`;
  - the front pages and their cursor;
  - a thread, more comments, a comment's context;
  - votes, a comment, a post and a delete, each once with the modhash;
  - a profile.

Nothing in a test reaches the network.
