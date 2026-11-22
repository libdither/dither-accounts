# LessWrong (kind `lesswrong`)

A LessWrong account as the `chat` interface, with posts only: no private messages. dither-chat's Feed page (its
`docs/feed.md`) shows your notifications, new posts by the authors you subscribe to, the site's "For you" feed, and
each post's comments with the post itself as an article, and answers them through it. It talks to the site's GraphQL
endpoint (`POST /graphql`, ForumMagnum, the code LessWrong, the EA Forum and the Alignment Forum share) with plain
requests: no browser. `extractors/lesswrong`.

## Adding it

On the manager's page, **Add → LessWrong**, one of two ways:

- **Username and password**: your **username or email** and your **password** (secret). It signs in at once
  (`login(username, password)`) and keeps only the login token the site gives, in `secret.json`; the password is
  dropped as soon as the site has answered. While the site cannot be reached it is kept, and tried again.
- **Login token**, for an account that signs in with Google or GitHub (it has no password): the value of the site's
  `loginToken` cookie, copied from a browser where you are signed in (secret).
- **Site** (optional): `https://www.lesswrong.com` unless you name another ForumMagnum site
  (`forum.effectivealtruism.org`, `www.alignmentforum.org`).

The token goes only to the site's own origin, as the `loginToken` header its own client sends; redirects are not
followed. It is never written to a log or a status. The session is checked with `currentUser`: that person is you,
announced as the account's own identity (no picture: the site keeps none for most people).

When the site stops taking the token (it ended, or you signed out everywhere), the token is dropped and the account asks
for a sign-in: a `login` attention in words and a box on the account's pane (the `relogin` action). With a username it
takes your password; without one, a new login token. A refused password is said in the same way.

Actions: `relogin { password }` or `relogin { token }`, `poll` (read notifications now).

## What it does

| Command | On the site |
|---|---|
| notifications (the feed) | `notifications(selector: { userNotifications: { userId } })`, newest first, 30 a page, every 4-8 minutes (a fixed `DITHER_LESSWRONG_POLL_MS` in tests): those newer than the newest heard, up to five pages, oldest first. A fresh account reads its last page as backfill (`live: false`) and notifies nothing; after that, one younger than 15 minutes when first heard is live. The comments and posts they name are read in one request each (`comments(selector: { default: { commentIds } })`, `posts(… exactPostIds)`). Nothing is marked read. |
| `history` (the feed) | Older pages by offset (`next`). |
| `home` following | `postsBySubscribedAuthors(limit)`: posts in the last 90 days by the people whose new posts you subscribe to, newest first. It takes no offset, so `more` (`n:<shown>`) asks for a longer list, up to 300. |
| `home` foryou | `UltraFeed`, the front page's "For you" feed, with your saved feed settings and `incognitoMode: true`, so it records nothing as served or seen. Posts, Spotlights (as pinned) and comment threads (the last comment, with those above it). `more` is `u:<session>:<endOffset>`. |
| `post` (a post) | `post` and `comments(selector: { postCommentsTop })`, 300 a page: one chain per top-level comment, its branch depth first. The post itself comes back with `article`, its whole body as Markdown (math as TeX, footnotes, links made whole). |
| `post` (a comment) | The comment, then `comments(selector: { repliesToCommentThreadIncludingRoot })` for its thread: the post (not for a quick take) and the comments above it as ancestors, the ones under it as replies. |
| `postAct` | like: `performVotePost` / `performVoteComment` with `smallUpvote`; unlike: `neutral`. Your agreement vote and reactions are read first and sent back with it, as the site's buttons do (a vote without them clears them). A strong upvote counts as liked; a downvote is not undone by unlike. Repost is refused. |
| `publish` | A comment, in Markdown: `createComment({ postId, parentCommentId?, contents: { originalContents: { type: "markdown" } } })`, answering a post (`p-…`) or a comment (`c-…`). The same command id twice makes one comment. A new post (`title`, `place`, or no `replyTo`) is refused: it is written on the site. So are quotes, pictures, content warnings and reply limits. |
| `unpublish` | Your own comment, while nothing answers it: `moderateComment(commentId, deleted: true, deletedPublic: false)`. Gone already counts as deleted. A post is refused (400), someone else's comment (403), a comment with replies (409: retract it on the site). |
| `profile` | A user `_id`, or a slug (`GetUserBySlug`): bio, karma, post and comment counts, links, and their newest posts and comments together (20). |

Capabilities: `history`, `profile`, `posts`, `postActions`, `publish`, `home`, `unpublish`. No `postReactors`: the site
names no voters.

## Never called

Nothing marks a notification or post read, records a view, or changes your settings. The kind never sends:

- `MarkAllNotificationsAsRead`, `markAsReadOrUnread`, `markPostCommentsRead`, `updateNotification`,
  `markConversationRead`
- `increasePostViewCount`, `analyticsEvent`, `createLWEvent`, `updateContinueReading`
- `createUltraFeedEvent` / `ultraFeedEvent` (served and viewed tracking), and `UltraFeedSubscriptions`, the
  Subscribed tab's own query, which records what it served
- `karmaChangesChecked`, `updateUser` (which is how the site sets `lastNotificationsCheck`)

`test/lesswrong.test.ts` checks every request the fake heard against this list, and that UltraFeed was always
incognito. The operations it does send are `OPERATIONS` in `extractors/lesswrong/src/queries.ts`.

## Facts and ids

- **People** are the site's user `_id` (17 characters), with the slug as the handle (bare, no `@`), the display name,
  and the profile `https://www.lesswrong.com/users/<slug>`. The site itself, the author of a notification whose comment
  is gone, is `lesswrong`, a bot.
- **Posts** are `p-<_id>` and **comments** `c-<_id>`. A quick take (shortform) is a comment: it answers nothing and
  roots its own thread; comments under it have it as `root`.
- **The feed** is one conversation, `feed:<your _id>`, shape `channel`, variant `feed`, named Notifications. Messages
  are FeedItems: `reply:<comment>` (an answer to you; one on your post carries the post), `mention:<comment or post>`,
  and `other:<notification>:<author or ->` for everything else (a new post by someone you follow, a comment on a post
  you subscribe to), the site's words with the post or comment they name, or a link.
- **PostFact** of a post: `title`, `url`, text the start of the body in plain words (a link post's link first), `counts`
  (`likes` its karma, `baseScore`; `replies` its comments), `viewer.liked` (your upvote). Of a comment: its words,
  whole (up to 20,000 characters), `replyTo` its parent or the post, `root` the post (or its quick take), `counts`
  (karma, direct replies). A retracted comment carries the warning "Retracted by its author"; a deleted one says
  `[deleted]`.

## Pace and limits

One request at a time: a read 1-2.5 s after the one before, a write 0.6-1.2 s (`DITHER_LESSWRONG_PACE_MS` scales both;
tests set 0). Notifications every 4-8 minutes, everything else only when asked. A 429 is waited out (its
`Retry-After`, else a minute); failures back off from 5 s, doubling, up to ten minutes.

Not built: private messages, posting, editing, downvotes and agreement votes, reactions, bookmarks, subscribing.

## Tests

`extractors/lesswrong/test/fake-lesswrong.ts` fakes the GraphQL endpoint by operation name, with invented people,
posts, comments and notifications. `test/lesswrong.test.ts` runs the kind in a manager against it: the password and
the token way, a refused password, the feed and its first quiet read, live notifications, history, both timelines,
threads of posts, comments and quick takes, votes, commenting, deleting, profiles, a session that ends, and the
never-called list. `extractors/lesswrong/test/map.test.ts` covers the mapping and the GraphQL client. The queries were
checked against the live schema signed out; signing in and writing were not tried on a real account.
