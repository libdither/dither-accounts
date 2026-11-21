# Bluesky (kind `bluesky`)

A Bluesky account as the `chat` interface, with posts only: no direct messages. dither-chat's Feed page (its
`docs/feed.md`) shows its notifications, Following timeline, Discover and threads, and answers them through it. It
talks to the AT Protocol's HTTP API (XRPC) on the account's own server (its PDS) with plain requests: no browser, no
firehose. `extractors/bluesky`.

## Adding it

On the manager's page, **Add → Bluesky**:

- **Handle or email**: `alice.bsky.social`, your own domain if you use one as your handle, or the email you sign in
  with.
- **App password** (secret): one made under Settings → Privacy and security → App passwords. Not your main password:
  an app password cannot change your account's settings and can be revoked on its own. Tick "Allow access to your
  direct messages" or not; this kind does not read them either way.
- **Server** (optional): where an email signs in, `https://bsky.social` by default. With a handle it is only where the
  handle is looked up.

How it signs in:

1. A handle is resolved to its DID (`com.atproto.identity.resolveHandle` on the server above), the DID to its document
   (`https://plc.directory/<did>` for `did:plc`, `https://<host>/.well-known/did.json` for `did:web`), and the
   document names the account's PDS (`#atproto_pds`). An email signs in at the server above, and the session's own DID
   document then names the PDS.
2. `com.atproto.server.createSession` on the PDS with the handle and app password. The session it gives (`accessJwt`,
   `refreshJwt`, the DID, the PDS) is kept in `secret.json` (`session`) beside the app password.
3. When the access token expires, `com.atproto.server.refreshSession` swaps the refresh token for a new pair, and the
   request is made again. When the server takes neither any more, it signs in again with the app password, by itself.

What it asks of you, on the account's pane:

- **A refused app password** (revoked, mistyped, or the account taken down): a `login` attention in words and a
  password box (the `relogin` action, `{ password }`: a new app password, kept and used at once).
- **A sign-in code by email**: when the server answers `AuthFactorTokenRequired` (two-factor by email is on), a
  `verify` attention with `detail.code = { type: 'text', length: 11 }` and a code box (the `signIn` action,
  `{ code }`, like `ABCDE-12345`; dashes and case are forgiven). A code is for one sign-in; the session that follows
  lasts until it is revoked, so a code is needed again only when it signs in afresh.

Actions: `relogin { password? }` (without one, signs in again with the kept app password), `signIn { code }`, `poll`
(read notifications now).

Not built: OAuth (the AT Protocol's own, with DPoP and a client metadata document at a public URL). It would replace
the app password; the sign-in steps above stay the same apart from step 2.

## What it does

| Command | On Bluesky |
|---|---|
| notifications (the feed) | `app.bsky.notification.listNotifications` (40 a page), every minute (`DITHER_BLUESKY_POLL_MS`): those indexed after the newest heard (its `indexedAt`, and the ones heard at that same moment), paging back by cursor up to ten pages, oldest first. The posts they are about come from `app.bsky.feed.getPosts`, 25 at a time. A fresh account reads its last 40 as backfill (`live: false`); after that, one younger than 15 minutes when first heard is live. Nothing is marked seen on the server (no `updateSeen`). |
| `history` (the feed) | Older notifications by Bluesky's cursor (`next`). |
| `home` following | `app.bsky.feed.getTimeline`; `more` is Bluesky's cursor. Bluesky's timelines page only backwards, so `top` is always null. A repost is the reposter's post with `repostOf`. |
| `home` foryou | Bluesky's Discover feed, `app.bsky.feed.getFeed` with the `whats-hot` generator (`DITHER_BLUESKY_DISCOVER` names another), each with the reason "Discover". |
| `post` | `app.bsky.feed.getPostThread` (10 deep, 80 up): ancestors oldest first, and the replies as one chain per direct reply (that reply's whole branch, depth first, in the server's order), each post saying what it answers. Posts not found or blocked are left out. The thread comes whole: never a next page. |
| `postAct` | like and repost make an `app.bsky.feed.like` or `app.bsky.feed.repost` record with the post's uri and cid (`com.atproto.repo.createRecord`); unlike and unrepost delete it (`deleteRecord`). The cid and your like and repost records are remembered from every post it has read; a post it has not read (or an undo whose record it does not know) is read first with `getPosts`. Liking a post already liked does nothing. The reply is how the post stands after. |
| `publish` | An `app.bsky.feed.post` record. Its length is checked first as Bluesky counts it: 300 graphemes. Links, `@handles` (each resolved to its DID; one that resolves to nobody stays words) and `#tags` become facets, by UTF-8 byte offsets. A reply carries `reply.root` and `reply.parent` (each a uri and cid; the root is the parent's root). `quote`: an `app.bsky.embed.record` (refused when its author turned quoting off); `media`: up to 4 pictures (JPEG, PNG, WebP, GIF; 1 MB each, not resized), each through `com.atproto.repo.uploadBlob`, as `app.bsky.embed.images`, or `recordWithMedia` with a quote. `replies` `following` or `mentioned` adds a thread gate (`app.bsky.feed.threadgate`, same rkey) on a new post; `verified` is refused. `title`, `place`, `warning` and videos are refused. Bluesky takes no idempotency key: the same command id twice in one run makes one post. |
| `unpublish` | `deleteRecord` of your own post (and its thread gate); already gone counts as deleted; someone else's is refused. |
| `postReactors` | `app.bsky.feed.getLikes` or `getRepostedBy`, 50 a page, `more` Bluesky's cursor, with whether you follow each and they follow you. |
| `profile` | `app.bsky.actor.getProfile` by handle or DID, and `app.bsky.feed.getAuthorFeed` (posts and their own threads, a pinned post first): bio, counts, whether you follow each other, the DID as a fact. |

Capabilities: `history`, `profile`, `posts`, `postActions`, `publish`, `postReactors`, `home`, `unpublish`, `postMedia`.

## Facts and ids

- **People** are their DID (`did:plc:…`, `did:web:…`), which stays when a handle changes. Handle `@<handle>`; a
  handle the server says is invalid is left out.
- **Posts** are `<did>~<rkey>`, from `at://<did>/app.bsky.feed.post/<rkey>` (the hub's `POST_ID_PATTERN`,
  `[A-Za-z0-9_.~:-]{1,120}`: no `/`). A repost in a timeline is its repost record's `<did>~<rkey>`, or
  `<reposter's did>~r<rkey>` when the server does not name the record; act on its `repostOf`, not on it. A post opens
  at `https://bsky.app/profile/<handle>/post/<rkey>` (`DITHER_BLUESKY_WEB` names another web app).
- **The feed** is one conversation, `feed:<your DID>`, shape `channel`, variant `feed`, named Notifications. Messages
  are FeedItems (chat-protocol `feed.ts`): `like:<post>:<did>`, `repost:<post>:<did>`, `follow:<did>`,
  `reply:<their post>` (a reply, or a mention whose post answers yours, with your post as `post`), `mention:<their
  post>`, `quote:<their post>`, and `other:<record>:<did>` for the rest in words: someone joined through your starter
  pack, your account was verified or no longer is, a like or repost of a post you reposted, a post by someone whose
  posts you asked to hear about.
- **PostFact**: text with link facets expanded to the whole address (the composer shortens what it shows), a link
  card's address after the words when they do not hold it, `media` (pictures; a video by its poster frame), `repostOf`,
  `quoteOf`, `replyTo` with its author (the parent's DID), `root`, counts (replies, reposts, likes, quotes), `viewer`,
  `lang` (the record's first), and `replies` when a thread gate limits them.

## Pace and limits

Notifications once a minute, and everything else only when asked. Every answer's `RateLimit-Remaining` and
`RateLimit-Reset` (epoch seconds) are kept: with three or fewer left, nothing is sent until the reset, and a 429 is
waited out as `Retry-After` (or the reset) says. A refused command reaches the app with the server's status and words
(a rate limit as 429). Failures back off from 5 s, doubling, up to ten minutes. The tokens are sent only to the PDS;
the handle and DID lookups go without them; redirects are not followed. A PDS on plain http is taken only when the
server field is http too (a local or test setup).

Not built: OAuth, direct messages (`chat.bsky.*`, which an app password may be allowed to read), videos (they go
through Bluesky's video service), GIFs from a GIF search, alt text on pictures (the hub sends none), labels and
content warnings (Bluesky's are labels from moderation services, not words the author writes), editing a post
(Bluesky has none), follows, mutes and blocks from the hub, custom feeds beyond Discover.

## Tests

`extractors/bluesky/test/fake-bluesky.ts` fakes the entryway, the PLC directory and a PDS with its app view, with
invented DIDs and `*.example` handles; `test/bluesky.test.ts` runs the kind in a manager against it (signing in by
handle and by email, the code by email, a refused app password, the feed, polling, history, Following and Discover,
threads, acting, posting with facets, quotes, pictures and a thread gate, deleting, reactors, profiles, a refreshed
session, a rate limit), and `extractors/bluesky/test/map.test.ts` the ids, facets and the client's rate limits. Not
yet checked against a live account.
