# Mastodon (kind `mastodon`)

A Mastodon account as the `chat` interface, with posts only: no direct messages. dither-chat's Feed page (its
`docs/feed.md`) shows its notifications, home timeline, trending posts and threads, and answers them through it. It
talks to the server's own REST API with plain requests: no browser, no streaming. `extractors/mastodon`.

## Adding it

On the manager's page, **Add → Mastodon**:

- **Server**: your server's address, `https://mastodon.example` (or just `mastodon.example`), the part after the
  second @ in your address.
- **Access token** (secret, optional): one made under Preferences → Development → New application with the `read`,
  `write` and `follow` scopes. With it the account is online at once.

Without a token it signs in the way Mastodon's own apps do, out of band:

1. It registers itself on the server as an app named `dither-accounts` (`POST /api/v1/apps`, redirect
   `urn:ietf:wg:oauth:2.0:oob`, scopes `read write follow`), and keeps its client id and secret in `secret.json`
   (`app`, with the server it is for).
2. The account asks for you: **Sign in on <server>** opens the server's authorize page in your browser. You sign in
   there (your password and second factor never pass through here) and approve.
3. The server shows a code. Paste it in the box under the link; the account swaps it for a token
   (`POST /oauth/token`), keeps the token in `secret.json` (`token`) and goes online. A code works once and expires
   in minutes; **Sign in** again for a new one. An access token pasted in that box is taken too.

The attention is `kind: 'login'` with `detail.signIn = { url, host, action: 'signIn' }` (chat-protocol's
`SignInCheck`): the page's `SignInEntry` draws it, and anything else can run the `signIn` action with `{ code }`.
Actions: `signIn { code }`, `startSignIn` (forget the token and show a new link), `poll` (read notifications now).

Once signed in, `GET /api/v1/accounts/verify_credentials` is you: the account's own identity, with your picture
(`avatar`) unless it is the server's `missing.png` (no picture set).

When the server stops taking the token (revoked under Preferences → Account → Authorized apps, or expired), the
account forgets it and asks for a sign-in again.

## What it does

| Command | On Mastodon |
|---|---|
| notifications (the feed) | `GET /api/v1/notifications`, every minute (`DITHER_MASTODON_POLL_MS`), with `min_id` the newest heard, oldest first, up to ten pages. A fresh account reads its last 40 as backfill (`live: false`); after that, one younger than 15 minutes when first heard is live. Nothing is marked read on the server. |
| `history` (the feed) | Older notifications by `max_id`; `next` is the page's oldest notification id. |
| `home` following | `GET /api/v1/timelines/home`: `more` is `max:<id>`, `top` is `min:<id>`. Boosts come as the booster's post with `repostOf`. |
| `home` foryou | `GET /api/v1/trends/statuses` by `offset` (`more` is `off:<n>`), each with the reason "Trending on <server>". |
| `post` | `GET /api/v1/statuses/:id` and `/context`: ancestors, and the descendants as one chain per direct reply (that reply's whole branch, depth first), each post saying what it answers. The context comes whole: never a next page. |
| `postAct` | like `favourite`, unlike `unfavourite`, repost `reblog`, unrepost `unreblog`; the reply is how the post stands after. |
| `publish` | `POST /api/v1/statuses` with an `Idempotency-Key` made from the command's id. A reply starts with `@<their address>` unless it already names them, as Mastodon's own composer does (else they are not told), and is no more public than what it answers. `warning` is the content warning (`spoiler_text`). `quote`: Mastodon 4.5's `quoted_status_id` when the quoted post says how it may be quoted (`quote_approval`; refused when it says you may not), else the quoted post's link at the end of the words. `media`: `POST /api/v2/media`, waited for while the server processes it (up to 60 s), at most the server's count (4). The length is checked first as Mastodon counts it: the server's `max_characters` (500 by default), each link 23, a remote mention by its username. `title`, `place` and a reply limit are refused: Mastodon has none. |
| `unpublish` | `DELETE /api/v1/statuses/:id`; already gone counts as deleted. |
| `postReactors` | `favourited_by` or `reblogged_by`, 40 a page, `more` from the `Link` header's `max_id`. Anyone may see who favourited. |
| `profile` | `GET /api/v1/accounts/lookup` (a local person by username), else `GET /api/v2/search?resolve=true` (asks the server to fetch someone from another server), then the relationship, pinned posts and the last 20 posts. Bio and profile fields as text, verified links marked. |

Capabilities: `history`, `profile`, `posts`, `postActions`, `publish`, `postReactors`, `home`, `unpublish`, `postMedia`.

## Facts and ids

- **People** are `user@domain`, their full address (a local account's `acct` gets the server's `domain` from
  `/api/v2/instance`), so the same person from two accounts on different servers is one identity on the hub. Handle
  `@user@domain`.
- **Posts** are `<api host>:<status id>`: a status id means something only on the server that gave it, and a post id
  takes no `@` (the hub's `POST_ID_PATTERN`, `[A-Za-z0-9_.~:-]{1,120}`). A command for a post of another host is
  refused (404).
- **The feed** is one conversation, `feed:<your address>`, shape `channel`, variant `feed`, named Notifications.
  Messages are FeedItems (chat-protocol `feed.ts`): `like:<post>:<user>` (favourite), `repost:<post>:<user>`
  (boost), `follow:<user>`, `reply:<their post>` (a mention whose post answers yours), `mention:<their post>`,
  `quote:<their post>` (Mastodon 4.5), and `other:<notification id>:<user or ->` for the rest in words: someone you
  turned notifications on for posted (`status`), a poll ended, a boosted post was edited, a follow request, moderation
  notices. A notification no person sent is authored by the server (identity `<domain>`).
- **PostFact**: text from the status's HTML (paragraphs, line breaks, links expanded to where they go, mentions and
  hashtags as their words), `warning`, `media` (pictures; a video or GIF by its preview), `repostOf`, `quoteOf`,
  `replyTo` with its author where the status names them, counts (replies, boosts, favourites, quotes), `viewer`,
  `lang`, and a poll's options as lines after the words.

## Pace and limits

Notifications once a minute, and everything else only when asked. Every answer's `X-RateLimit-Remaining` and
`X-RateLimit-Reset` are kept: with three or fewer left, nothing is sent until the reset, and a 429 is waited out as
`Retry-After` (or the reset) says. A refused command reaches the app with the server's status and words. Failures back
off from 5 s, doubling, up to ten minutes. The token is sent only to the server's own origin; redirects are not
followed.

Not built: streaming, direct messages (Mastodon's are posts of `direct` visibility; they show as mentions), polls
answered here, editing a post, bookmarks, follows and blocks from the hub.

## Tests

`extractors/mastodon/test/fake-mastodon.ts` fakes the API with invented people and posts; `test/mastodon.test.ts`
runs the kind in a manager against it (sign-in by code and by token, the feed, polling, history, home and trends,
threads, acting, posting, deleting, reactors, profiles, a revoked token), and `extractors/mastodon/test/map.test.ts`
the mapping and the HTTP client's rate limits. Not yet checked against a live server.
