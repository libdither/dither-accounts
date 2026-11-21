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
| the front page, as a page | `GET /new/` or `/best/`, then the page's own "next" link (`?count=25&after=<t3_…>`) | `home`, when its `.json` is refused |
| your picture | `GET /user/<you>/about.json?raw_json=1` | once after online; 10 minutes after a failed read |
| a post's thread | `GET /comments/<id>.json?raw_json=1&sort=confidence` | `post`, when asked |
| a comment's thread | `GET /comments/<post>/_/<comment>.json?raw_json=1&sort=confidence&context=8` | `post` with a `t1_` id |
| a thread, as a page | `GET /comments/<post>/?sort=confidence`, `/comments/<post>/_/<comment>/?sort=confidence&context=8` | `post`, when the `.json` is refused |
| which post a comment is under | `GET /api/info.json?id=t1_…` | only for a comment not seen since the start |
| more comments | `POST /api/morechildren` (`link_id`, `children` up to 100, `sort`, `limit_children=false`, `api_type=json`) | `post` with a cursor ("load more comments") |
| a profile | `GET /user/<name>/about.json`, then `/user/<name>/overview.json?limit=25` | `profile`, when asked |
| upvote, clear vote | `POST /api/vote` (`id`, `dir` 1 or 0) | `postAct` like, unlike |
| comment | `POST /api/comment` (`thing_id`, `text`, `api_type=json`) | `publish` with `replyTo` |
| new text post | `POST /api/submit` (`kind=self`, `sr`, `title`, `text`, `sendreplies=true`, `api_type=json`), then `GET /api/info.json?id=t3_…` to read it back | `publish` with `title` and `place` |
| delete | `POST /api/del` (`id`) | `unpublish` |

**When Reddit refuses the `.json`.** Since autumn 2026 Reddit's network security answers some signed-in `.json`
reads with an HTML 403 ("You've been blocked by network security"): live, the front page sorted New (and Hot, and any
subreddit's New), while Best, the inbox and profiles answer. Other projects see the same for listings and search
([OpenCLI #2771](https://github.com/jackwener/OpenCLI/issues/2771)); the pages a person opens still load. So when a
`.json` read answers 403, the same thing is read from its page, from inside the signed-in tab: the hook fetches the
page, parses it there (`DOMParser`), and gives back the `.json`'s shape, so the extractor maps it as before. For six
hours after a refusal (per front page, and for comments) only the page is read.

What a page gives is what old reddit draws: each post row (`.thing.link`) carries its facts in data- attributes
(`data-fullname`, `data-author`, `data-subreddit`, `data-subreddit-fullname`, `data-timestamp`, `data-permalink`,
`data-url`, `data-score`, `data-comments-count`, `data-nsfw`, `data-spoiler`, `data-promoted`), its title is
`a.title`, your vote the arrows' column (`likes`, `dislikes`, `unvoted`), and its picture the link itself on Reddit's
picture host or else the row's thumbnail. On a comments page the post's text is its expando, and each comment
(`.thing.comment`) gives `data-fullname`, `data-author`, `data-permalink`, its time (`time[datetime]`), the score that
matches your vote, and its text, turned back into plain Markdown (paragraphs, quotes, lists, code, links); answers are
the comment's `.child .sitetable`, "load more comments" the ids in its `morechildren(...)` link, and "continue this
thread" a `more` with id `_`, as in the `.json`. Lost against the `.json`: text formatting beyond that, galleries,
videos' frames and crossposts.

Not made up here: the next page is the page's own "next" link (kept by its `after`; only when that is not known, as
after a restart, is `?count=25&after=` asked), and only pages a person opens are read (`/new/`, `/best/`,
`/comments/…`). A page that loads but is not drawn as above fails with what was missing ("not laid out as known: no
list of posts on the page"), so the status says which read broke.

A refusal with no message in its body is described by its content type, its page
title, where it was redirected, its first visible words and its size, so the log tells a block page from a sign-in
redirect, and says what a page with no title gives as its reason.

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
  - Following and For you from their pages when their `.json` answers Reddit's block page, with the page's own "next"
    link, and the block page's words when the page is refused too (`extractors/reddit/test/old-pages.ts` draws the
    pages as old reddit does, from the same data);
  - your picture on your identity;
  - a thread, more comments, a comment's context; and the same from the comments pages when their `.json` is refused;
  - votes, a comment, a post and a delete, each once with the modhash;
  - a profile.

Nothing in a test reaches the network.
