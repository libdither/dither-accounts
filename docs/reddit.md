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
| your subscriptions | `GET /subreddits/mine/subscriber.json?raw_json=1&limit=100[&after=<t5_…>]`, up to 1,000 | Following, when `/new.json` is refused; kept 30 minutes |
| a group of them, newest first | `GET /r/<a>+<b>+…/new.json?raw_json=1&limit=<n>[&after=<t3_…>]`, 100 names a group | the same |
| your picture | `GET /user/<you>/about.json?raw_json=1` | once after online; 10 minutes after a failed read |
| a post's thread | `GET /comments/<id>.json?raw_json=1&sort=confidence` | `post`, when asked |
| a comment's thread | `GET /comments/<post>/_/<comment>.json?raw_json=1&sort=confidence&context=8` | `post` with a `t1_` id |
| which post a comment is under | `GET /api/info.json?id=t1_…` | only for a comment not seen since the start |
| more comments | `POST /api/morechildren` (`link_id`, `children` up to 100, `sort`, `limit_children=false`, `api_type=json`) | `post` with a cursor ("load more comments") |
| a profile | `GET /user/<name>/about.json`, then `/user/<name>/overview.json?limit=25` | `profile`, when asked |
| upvote, clear vote | `POST /api/vote` (`id`, `dir` 1 or 0) | `postAct` like, unlike |
| comment | `POST /api/comment` (`thing_id`, `text`, `api_type=json`) | `publish` with `replyTo` |
| new text post | `POST /api/submit` (`kind=self`, `sr`, `title`, `text`, `sendreplies=true`, `api_type=json`), then `GET /api/info.json?id=t3_…` to read it back | `publish` with `title` and `place` |
| delete | `POST /api/del` (`id`) | `unpublish` |

**Following when New is refused.** Some signed-in accounts get a bare 403 for the front page sorted New
(`/new.json`), while Best (`/best.json`) and the inbox answer. Then Following is built the way it is defined, from
your subscriptions: their names, then each group of up to 100 as a multireddit (`/r/a+b+c/new.json`, Reddit's
documented `[/r/subreddit]/new` listing, which takes `+`-joined names), merged newest first. The cursor
(`subs~<place>.<place>…`) says where each group is up to (`0` from the top, a `t3_` after that post, `x` done), so it
pages with nothing kept. `/new.json` is not asked again for six hours. A followed person counts as their `u_name`
subscription.

**Never marked read.** The inbox is read with `mark=false`, and the hook refuses an inbox read without it. A
`.json` listing does not mark anything read anyway (Reddit marks the inbox read only when its HTML page is opened
without `mark=false`).

**A person's pace.** Reads wait 2.5-6 s after the last one, and writes 1.2-2.1 s. Nothing runs in the background but
the inbox look, and that waits while a command runs. Each write is made once and never retried. Reddit's refusal comes
back in its own words (`json.errors`, as in "Reddit said: you are doing that too much").

**Still to confirm on a signed-in page** (built from Reddit's public API documentation and old reddit's open source,
not yet seen live):

- that old.reddit.com still serves signed-in accounts (signed out, it now sends you to sign in: `reason=lor2`);
- that `r.config.logged` and `r.config.modhash` are still there;
- that `/api/vote` takes `id`, `dir` and `uh` alone (old reddit's arrows may also send `vh`, a vote hash, and `rank`);
- that `/api/comment`, `/api/submit` and `/api/morechildren` answer `api_type=json` as documented. The page's own
  forms ask for `renderstyle=html` instead, which is the same endpoint with the answer drawn as HTML.

## How it maps

Ids are Reddit's fullnames, so a post and a comment never share one: `t3_…` for posts, `t1_…` for comments, `t4_…`
for messages. People are their usernames (Reddit never renames an account), shown as `u/name`. `[deleted]` is nobody.
A message from a subreddit is authored by `r/name`, and one from Reddit itself by `reddit:system`.

**Posts** (PostFact):

- `title`, and `place` (the subreddit: its `t5_` id, `r/name` and link);
- the text: selftext, or the link of a link post;
- `media`: a gallery's pictures in order with their captions, else the preview picture (a video's poster frame);
- `counts`: the score as `likes`, the comment count as `replies`;
- `warning`: "NSFW", "Spoiler" or both;
- `viewer.liked`: true when you upvoted it;
- `quoteOf`: a crosspost's original.

**Comments** are posts with `replyTo` (the parent's fullname) and `root` (the post).

**Threads** (PostThread) give each top-level comment as a chain: the comment, then every answer under it depth first.
The hub puts each one under what it answers, so the tree comes back whole. Each comment's `counts.replies` counts its
answers, the ones sent and the ones Reddit left behind a `more`. "Continue this thread" counts one, so the hub offers
"N more replies" and opens that comment's own thread. `more` is a cursor `<post>.<more id>.<offset>` for the
top-level "load more comments". `/api/morechildren` takes 100 at a time; past that, the cursor's offset moves on.

**The inbox** is the conversation `feed` (variant `feed`, "Notifications"). Each message's `extra.feed` is a FeedItem:

| Reddit | type | message |
|---|---|---|
| comment reply, post reply | `reply` | their comment as `theirs`; for a post reply, your post's id and title as `post` |
| username mention | `mention` | their comment as `theirs` |
| a message to you, a subreddit's message, anything else | `other` | the subject as the words, the message as `theirs` |

Reddit names nobody who voted, so there are no `like` items and no `postReactors`. A fresh account takes the first
page of 25 from the last seven days, as backfill. After that, a message is live (it may notify) only when it is newer
than anything announced and under 15 minutes old. `reddit-state.json` keeps the newest time and the ids lately
announced.

**Profiles** (PersonAbout):

- the profile's title as the name;
- the picture and the profile's description;
- the cake day as `createdAt` and as a fact, with total, post and comment karma as facts;
- a link to u/name;
- `friend` when they are your Reddit friend;
- `posts`: their last 25 posts and comments, at most 20 kept.

## Writing

`publish` with `replyTo` (a `t3_` or `t1_`) is a comment. Without it, it is a new **text post**, and it needs `title`
(at most 300 characters) and `place`, the subreddit's bare name (`rust`; `r/rust` is taken too). A post may be its
title alone. `title`, `place` and `warning` are the protocol's `publish` fields for posts with titles and places, as
dither-chat's hub sends them. Reddit has no content warning, so a `warning` is refused. Text is checked against
Reddit's own limits before anything is sent: 10,000 characters in a comment, 40,000 in a post's body (graphemes, as
`POST_RULES` counts). Not offered: quoting, reposts and crossposts (the hub never asks), "who can reply", pictures and
video (`postMedia`), and link posts. Nobody is named for an upvote, so the hub never asks who voted. A comment Reddit
made but did not describe is never answered as failed: you are told to look on Reddit before commenting again.

## Capabilities

`liveView` always. Once signed in on old.reddit.com it adds `home`, `posts` and `profile`, and, with the page's modhash,
`postActions`, `publish` and `unpublish`.

## Status

The status layers are display, browser, extension, signed in (`as u/name`), page and inbox:

- **page:** old.reddit.com with its modhash. Without one it reads but does not write, and this layer fails.
- **inbox:** the items announced and when it last read, or the last error.

Your own identity (the status's `self` and its identity fact) carries your picture once your profile is read: the one
you set (`snoovatar_img`, else `icon_img`, `&amp;` unescaped as for everyone). Reddit's default snoo
(`redditstatic.com/avatars/defaults/…`) is no picture of yours, so you stay without one.

## Tests

- `extractors/reddit/test/map.test.ts`: the mapping, against invented data in Reddit's shapes (`test/fixtures.ts`).
- `extractors/reddit/test/status.test.ts`: the status.
- `test/reddit-browser.test.ts`: the end-to-end run. A real manager runs the kind, in a real Chromium on Xvfb with its
  extension, against `test/fake-reddit.ts`, a fake old.reddit.com that records every request. It checks:
  - signed out: sign-in attention, nothing read;
  - after signing in: online, and the inbox as the feed, read with `mark=false`;
  - the front pages and their cursor;
  - Following from the subscriptions when `/new.json` answers 403, merged and paged;
  - your picture on your identity;
  - a thread, more comments, a comment's context;
  - votes, a comment, a post and a delete, each once with the modhash;
  - a profile.

Nothing in a test reaches the network.
