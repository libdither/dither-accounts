# Lemmy (kind `lemmy`)

A Lemmy account as the `chat` interface, with posts only: no private messages. dither-chat's Feed page (its
`docs/feed.md`) shows the replies and mentions waiting for you, your subscribed communities, what is hot across your
instance and each post's comments, and answers them through it. It talks to the instance's HTTP API v3 (Lemmy 0.19)
with plain requests: no browser. `extractors/lemmy`; its HTTP client is the mastodon kind's
(`@dither-accounts/extractor-mastodon/http`).

## Adding it

On the manager's page, **Add → Lemmy**:

- **Instance**: `https://lemmy.example` (or just `lemmy.example`).
- **Username or email**, as you sign in on the instance.
- **Password** (secret).
- **Two-factor secret** (secret, optional, only with two-factor on): the base32 secret your authenticator app holds,
  or its `otpauth://` link, so the account can sign in again by itself; or the current 6-digit code, used for this
  sign-in only.

It signs in at once (`POST /api/v3/user/login`) and keeps the session the instance gives (`jwt`) in `secret.json`
beside the password. When the instance stops taking the session (it ended, or the password changed elsewhere) it signs
in again with the password, by itself.

What it asks of you, on the account's pane:

- **A refused password** (or an instance that has not approved the registration, or wants the email verified): a
  `login` attention in words, and a password box (the `relogin` action, `{ password }`) that signs in with it.
- **A two-factor code** when it has no secret: a `verify` attention with `detail.code = { length: 6 }`, and a code box
  (the `signIn` action, `{ code }`).

Actions: `relogin { password }`, `signIn { code }`, `poll` (read replies and mentions now).

## What it does

| Command | On Lemmy |
|---|---|
| notifications (the feed) | `GET /api/v3/user/replies` and `/api/v3/user/mention` (sort New, 50), every minute (`DITHER_LEMMY_POLL_MS`): those newer than the newest heard of each, by their own ids, oldest first. A fresh account reads them as backfill (`live: false`); after that, one younger than 15 minutes when first heard is live. Nothing is marked read on the instance. |
| `history` (the feed) | A page of each list by page number (`next`). |
| `home` following | `GET /api/v3/post/list?type_=Subscribed&sort=New`, paged by `page_cursor` (`more` is `pc:<next_page>`; an instance without cursors, `page:<n>`). |
| `home` foryou | The same with `type_=All&sort=Hot`. |
| `post` (a post) | `GET /api/v3/post` and `GET /api/v3/comment/list?post_id=…&max_depth=8&sort=Hot`: one chain per top-level comment, its branch depth first. 50 top-level comments a page (`more` the next page). |
| `post` (a comment) | The comment, the post and the comments above it (at most ten) as ancestors, and `comment/list?parent_id=…` under it. |
| `postAct` | like: `POST /api/v3/post/like` or `/comment/like` with score 1; unlike: score 0. Repost is refused: Lemmy has none. |
| `publish` | A reply to a post: `POST /api/v3/comment { content, post_id }`; to a comment: with its `parent_id`. A new post needs `title` (at most 200 characters) and `place`, the community's address `!name@instance` (`GET /api/v3/community?name=` finds its id here), then `POST /api/v3/post { name, community_id, body }`. Quotes, pictures, content warnings and reply limits are refused. |
| `unpublish` | `POST /api/v3/post/delete` or `/comment/delete` with `deleted: true`; already gone counts as deleted. |
| `profile` | `GET /api/v3/user?username=…`: their posts and comments together, newest first (20), counts, and the communities they moderate. |

Capabilities: `history`, `profile`, `posts`, `postActions`, `publish`, `home`, `unpublish`. No `postReactors`: Lemmy
names who voted only to moderators and admins, so the feed has no likes either.

## Facts and ids

- **People** are `name@host`, the host of their own instance (from `actor_id`), the same from every instance.
- **Communities** (a post's `place`) are `!name@host`, named so, with the community's own URL.
- **Posts** are `p<id>@<api host>` and **comments** `c<id>@<api host>`: Lemmy's numbers mean something only on the
  instance that gave them, and a post and a comment may share one. A command for another host's is refused (404).
- **The feed** is one conversation, `feed:<your address>`, shape `channel`, variant `feed`. Messages are FeedItems:
  `reply:<their comment>` (an answer to your post, which comes with it as `post`, or to your comment) and
  `mention:<their comment>`.
- **PostFact** of a post: `title`, `place`, `url` (the post on your instance), text as Markdown (a link post's link
  first), a picture link or thumbnail as `media`, `counts` (comments, upvotes), `viewer.liked` (your vote is +1), NSFW
  as the `warning`, `pinned` when featured. Of a comment: its Markdown, `replyTo` its parent comment or the post,
  `root` the post, `counts` (children, upvotes). Deleted and removed ones say so in their words.

## Pace and limits

Two requests a minute for the feed, everything else only when asked. A 429 (or a rate-limit header, where the instance
sends one) is waited out; failures back off from 5 s, doubling, up to ten minutes. The session goes only to the
instance's own origin.

Not built: private messages, votes down, saving, subscribing, reporting, editing, posting a link or a picture.

## Tests

`extractors/lemmy/test/fake-lemmy.ts` fakes the API with invented people, communities, posts and comments;
`test/lemmy.test.ts` runs the kind in a manager against it (passwords wrong and right, the feed, polling, history,
home, threads of posts and comments, votes, commenting and posting, deleting, profiles, a session that ends, two-factor
by code and by secret, and RFC 6238's test vectors). Not yet checked against a live instance.
